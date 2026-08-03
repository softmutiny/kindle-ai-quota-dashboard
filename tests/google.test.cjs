'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  buildQuotaWindow,
  collectGoogle,
  isRealLimit,
  nextQuotaReset,
  pickQuotaMetric,
  quotaDayStart,
  reduceSeries,
  toUsedPct,
} = require('../src/collectors/google.cjs');
const { base64url, signAssertion } = require('../src/lib/google-auth.cjs');

const PACIFIC = 'America/Los_Angeles';

function pacificParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const field = {};
  for (const part of parts) field[part.type] = part.value;
  return field;
}

function decodeSegment(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

test('toUsedPct converts usage against a limit and clamps the range', () => {
  assert.equal(toUsedPct(750, 1500), 50);
  assert.equal(toUsedPct(1800, 1500), 100);
  assert.equal(toUsedPct(0, 1500), 0);
});

test('toUsedPct refuses to invent a percentage without a usable limit', () => {
  assert.equal(toUsedPct(750, 0), null);
  assert.equal(toUsedPct(750, undefined), null);
  assert.equal(toUsedPct(undefined, 1500), null);
});

test('the quota day starts at Pacific midnight and is never in the future', () => {
  for (const iso of ['2026-01-15T09:00:00Z', '2026-03-08T18:00:00Z', '2026-11-01T08:30:00Z']) {
    const now = new Date(iso);
    const start = quotaDayStart(now);
    const field = pacificParts(start);
    assert.equal(field.hour % 24, 0, `${iso} 起点不是太平洋午夜：${field.hour}:${field.minute}`);
    assert.equal(field.minute, '00');
    assert.ok(start.getTime() <= now.getTime(), `${iso} 起点落在了未来`);
    assert.ok(now.getTime() - start.getTime() < 25 * 60 * 60 * 1000, `${iso} 区间超过一天`);
  }
});

test('the next reset is Pacific midnight strictly ahead of now, across DST switches', () => {
  // 2026-03-08 与 2026-11-01 是美国夏令时的切换日。
  for (const iso of ['2026-01-15T09:00:00Z', '2026-03-08T09:30:00Z', '2026-11-01T08:30:00Z']) {
    const now = new Date(iso);
    const reset = nextQuotaReset(now);
    const field = pacificParts(reset);
    assert.equal(field.hour % 24, 0, `${iso} 重置点不是太平洋午夜：${field.hour}:${field.minute}`);
    assert.equal(field.minute, '00');
    assert.ok(reset.getTime() > now.getTime(), `${iso} 重置点没有越过现在`);
    assert.ok(reset.getTime() - now.getTime() <= 25 * 60 * 60 * 1000, `${iso} 重置点太远`);
  }
});

test('reduceSeries totals points per quota metric', () => {
  const series = [
    {
      metric: { labels: { quota_metric: 'generate_requests_per_day' } },
      points: [{ value: { int64Value: '120' } }, { value: { int64Value: '80' } }],
    },
    {
      metric: { labels: { quota_metric: 'embed_requests_per_day' } },
      points: [{ value: { doubleValue: 5 } }],
    },
    { metric: { labels: {} }, points: [{ value: { int64Value: '999' } }] },
  ];
  const totals = reduceSeries(series, (a, b) => a + b);
  assert.equal(totals.get('generate_requests_per_day'), 200);
  assert.equal(totals.get('embed_requests_per_day'), 5);
  assert.equal(totals.size, 2, '没有标签的序列不应该被计入');
});

test('pickQuotaMetric prefers the configured metric, then model calls over the superset', () => {
  // 真实 probe 输出里的两个指标名，都不带任何「日」标记。
  const found = new Map([
    ['generativelanguage.googleapis.com/api_requests', 81],
    ['generativelanguage.googleapis.com/generate_content_requests', 81],
  ]);
  assert.equal(
    pickQuotaMetric(found, 'generativelanguage.googleapis.com/api_requests'),
    'generativelanguage.googleapis.com/api_requests',
  );
  assert.equal(
    pickQuotaMetric(found, ''),
    'generativelanguage.googleapis.com/generate_content_requests',
  );
  assert.equal(pickQuotaMetric(new Map(), ''), null);
});

test('the card leads with the real call count and lets the bar carry the percentage', () => {
  const resetAt = '2026-08-04T15:00:00.000+08:00';
  const known = buildQuotaWindow(183, 150000, resetAt);
  assert.equal(known.displayValue, '183 次');
  assert.equal(known.resetAt, resetAt);
  assert.ok(known.usedPct > 0 && known.usedPct < 1, `期望 0.12% 量级，实际 ${known.usedPct}`);

  // 上限缺失或是 int64 哨兵时，进度条归零但次数照常显示。
  for (const limit of [undefined, 9223372036854775807]) {
    const unknown = buildQuotaWindow(9150, limit, resetAt);
    assert.equal(unknown.usedPct, 0);
    assert.equal(unknown.displayValue, '9,150 次');
  }
});

test('the int64 sentinel Google sends for "no limit" is not treated as a limit', () => {
  // probe 实测：上限序列返回 9223372036854775807，即 int64 最大值。
  assert.equal(isRealLimit(9223372036854775807), false);
  assert.equal(isRealLimit(Number.MAX_SAFE_INTEGER), false);
  assert.equal(isRealLimit(0), false);
  assert.equal(isRealLimit(-1), false);
  assert.equal(isRealLimit(undefined), false);
  assert.equal(isRealLimit(1500), true);
});

test('the collector reports why it produced nothing instead of showing zero', async () => {
  const disabled = await collectGoogle({ enabled: false });
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.ok, false);
  assert.deepEqual(disabled.windows, []);

  const locked = await collectGoogle({ enabled: true, projectId: 'demo' });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /allowLocalCredentialRead/);

  const noProject = await collectGoogle({ enabled: true, allowLocalCredentialRead: true });
  assert.equal(noProject.ok, false);
  assert.match(noProject.error, /projectId/);
});

test('signAssertion produces a JWT the matching public key verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const account = {
    client_email: 'dashboard@example.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const nowSeconds = 1_800_000_000;
  const assertion = signAssertion(account, 'https://www.googleapis.com/auth/monitoring.read', nowSeconds);

  const segments = assertion.split('.');
  assert.equal(segments.length, 3);
  assert.deepEqual(decodeSegment(segments[0]), { alg: 'RS256', typ: 'JWT' });
  const claim = decodeSegment(segments[1]);
  assert.equal(claim.iss, account.client_email);
  assert.equal(claim.aud, account.token_uri);
  assert.equal(claim.iat, nowSeconds);
  assert.equal(claim.exp, nowSeconds + 3600);
  assert.match(claim.scope, /monitoring\.read$/);

  const signature = Buffer.from(segments[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(`${segments[0]}.${segments[1]}`)
    .verify(publicKey, signature);
  assert.ok(verified, 'JWT 签名没有通过公钥验证');
});

test('base64url output carries no padding or URL-unsafe characters', () => {
  assert.doesNotMatch(base64url('any payload ??>>'), /[+/=]/);
});
