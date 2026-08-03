'use strict';

// 一次性诊断：把某个 Google 服务在 Cloud Monitoring 里真实上报的配额指标全部打印出来。
// 用途是确认 quotaMetric / dailyLimit 该怎么填，采集器本身不依赖这个脚本。
//   node scripts/probe-google-quota.cjs [service]

const { loadConfig } = require('../src/lib/config.cjs');
const { getAccessToken } = require('../src/lib/google-auth.cjs');
const { safeError } = require('../src/lib/common.cjs');
const {
  DEFAULT_SERVICE,
  LIMIT_METRIC,
  USAGE_METRIC,
  quotaDayStart,
} = require('../src/collectors/google.cjs');

const MONITORING_BASE = 'https://monitoring.googleapis.com/v3';

async function listRaw(token, projectId, metricType, service, interval) {
  const params = new URLSearchParams({
    filter: `metric.type="${metricType}" AND resource.labels.service="${service}"`,
    'interval.startTime': interval.startTime,
    'interval.endTime': interval.endTime,
  });
  const url = `${MONITORING_BASE}/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}：${safeError(text.slice(0, 300))}`);
  const payload = JSON.parse(text || '{}');
  return Array.isArray(payload.timeSeries) ? payload.timeSeries : [];
}

function describe(title, series) {
  process.stdout.write(`\n=== ${title} ===\n`);
  if (!series.length) {
    process.stdout.write('（没有任何时间序列返回）\n');
    return;
  }
  for (const item of series) {
    const labels = (item.metric && item.metric.labels) || {};
    const points = item.points || [];
    const values = points
      .map((point) => (point.value && (point.value.int64Value ?? point.value.doubleValue)))
      .filter((value) => value != null);
    process.stdout.write(
      `quota_metric=${labels.quota_metric || '(无)'}` +
      ` limit_name=${labels.limit_name || '(无)'}` +
      ` 点数=${points.length}` +
      ` 值=${values.slice(0, 6).join(',') || '(无)'}\n`,
    );
  }
}

async function main() {
  const service = process.argv[2] || DEFAULT_SERVICE;
  const config = loadConfig();
  const provider = (config.providers && config.providers.google) || {};
  const projectId = String(provider.projectId || '').trim();
  if (!projectId) throw new Error('config.json 里 providers.google.projectId 是空的');

  const now = new Date();
  const interval = {
    startTime: quotaDayStart(now).toISOString(),
    endTime: now.toISOString(),
  };
  process.stdout.write(
    `项目 ${projectId} / 服务 ${service}\n区间 ${interval.startTime} → ${interval.endTime}\n`,
  );

  const token = await getAccessToken(provider.credentialsFile);
  describe('用量 net_usage', await listRaw(token, projectId, USAGE_METRIC, service, interval));
  describe('上限 limit', await listRaw(token, projectId, LIMIT_METRIC, service, interval));
  process.stdout.write(
    '\n把上面想监控的那个 quota_metric 填进 config.json 的 providers.google.quotaMetric。\n',
  );
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
