'use strict';

const {
  clampPct,
  failedWindows,
  fetchJson,
  isoBeijing,
} = require('../lib/common.cjs');
const { getAccessToken } = require('../lib/google-auth.cjs');

const MONITORING_BASE = 'https://monitoring.googleapis.com/v3';
const USAGE_METRIC = 'serviceruntime.googleapis.com/quota/rate/net_usage';
const LIMIT_METRIC = 'serviceruntime.googleapis.com/quota/limit';
const DEFAULT_SERVICE = 'generativelanguage.googleapis.com';
const QUOTA_TIME_ZONE = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60 * 1000;
// Gemini 的 quota_metric 名字里没有任何「日」标记，只能按重要性挑：
// generate_content_requests 是真正的模型调用，api_requests 是它的超集。
const PREFERRED_METRICS = [/generate_content_requests$/i, /api_requests$/i];

// Cloud Monitoring 用 int64 最大值表示「该配额没有设上限」，
// 当成分母会让百分比恒为 0，必须识别出来并退回手填的 dailyLimit。
function isRealLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER;
}

// Google 的每日配额按太平洋时间午夜重置，所以统计区间必须从那个边界算起，
// 而不是「过去 24 小时」——否则跨过重置点之后百分比会一直偏高。
function zoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    // 必须锁 h23：部分 ICU 版本在 hour12:false 下把午夜报成「前一天 24 点」，
    // 那样算出来的日界会整整差一天。
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const field = {};
  for (const part of parts) field[part.type] = part.value;
  const wallClock = Date.UTC(
    Number(field.year),
    Number(field.month) - 1,
    Number(field.day),
    Number(field.hour) % 24,
    Number(field.minute),
    Number(field.second),
  );
  return wallClock - date.getTime();
}

function zoneDayStart(date, timeZone = QUOTA_TIME_ZONE) {
  // 调时当天，「此刻的偏移」和「当天午夜的偏移」可能差一小时，
  // 直接用前者反推会把日界推到前一天 23:00。所以拿结果的真实偏移再迭代收敛。
  let offset = zoneOffsetMs(date, timeZone);
  let start = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shifted = new Date(date.getTime() + offset);
    const midnight = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    );
    start = new Date(midnight - offset);
    const actual = zoneOffsetMs(start, timeZone);
    if (actual === offset) break;
    offset = actual;
  }
  return start;
}

function quotaDayStart(now = new Date()) {
  return zoneDayStart(now);
}

function nextQuotaReset(now = new Date()) {
  // 夏令时切换当天 +24h 可能落回同一天，所以逐日推进直到越过现在。
  let candidate = zoneDayStart(new Date(quotaDayStart(now).getTime() + DAY_MS));
  let guard = 0;
  while (candidate.getTime() <= now.getTime() && guard < 4) {
    candidate = zoneDayStart(new Date(candidate.getTime() + DAY_MS));
    guard += 1;
  }
  return candidate;
}

function toUsedPct(usage, limit) {
  const used = Number(usage);
  const total = Number(limit);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return clampPct((used / total) * 100);
}

function pointValue(point) {
  const value = point && point.value;
  if (!value) return null;
  if (value.int64Value != null) return Number(value.int64Value);
  if (value.doubleValue != null) return Number(value.doubleValue);
  return null;
}

function seriesKey(series) {
  const labels = (series && series.metric && series.metric.labels) || {};
  return String(labels.quota_metric || labels.limit_name || '');
}

function reduceSeries(series, reducer) {
  const totals = new Map();
  for (const item of series || []) {
    const key = seriesKey(item);
    if (!key) continue;
    for (const point of item.points || []) {
      const value = pointValue(point);
      if (value == null) continue;
      totals.set(key, totals.has(key) ? reducer(totals.get(key), value) : value);
    }
  }
  return totals;
}

function formatCount(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 次数做主、百分比只驱动进度条：付费层上限动辄十几万，
// 真实用量换算成百分比常常不足 1%，显示「0%」等于什么都没说。
function buildQuotaWindow(usage, limit, resetAt) {
  const usedPct = isRealLimit(limit) ? toUsedPct(usage, limit) : null;
  return {
    name: '每日',
    usedPct: usedPct == null ? 0 : usedPct,
    resetAt,
    displayValue: `${formatCount(usage)} 次`,
  };
}

function pickQuotaMetric(usageByMetric, configured) {
  if (configured) return configured;
  for (const pattern of PREFERRED_METRICS) {
    for (const key of usageByMetric.keys()) {
      if (pattern.test(key)) return key;
    }
  }
  const [first] = usageByMetric.keys();
  return first || null;
}

async function listTimeSeries(token, projectId, filter, interval, aggregation) {
  const params = new URLSearchParams({
    filter,
    'interval.startTime': interval.startTime,
    'interval.endTime': interval.endTime,
  });
  for (const [name, value] of Object.entries(aggregation || {})) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  }
  const url = `${MONITORING_BASE}/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`;
  const payload = await fetchJson(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return Array.isArray(payload && payload.timeSeries) ? payload.timeSeries : [];
}

async function readQuotaSeries(token, projectId, service, interval) {
  const alignmentSeconds = Math.max(
    60,
    Math.ceil((Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 1000),
  );
  const usage = await listTimeSeries(
    token,
    projectId,
    `metric.type="${USAGE_METRIC}" AND resource.labels.service="${service}"`,
    interval,
    {
      'aggregation.alignmentPeriod': `${alignmentSeconds}s`,
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      'aggregation.groupByFields': ['metric.label.quota_metric'],
    },
  );
  const limit = await listTimeSeries(
    token,
    projectId,
    `metric.type="${LIMIT_METRIC}" AND resource.labels.service="${service}"`,
    interval,
    {
      'aggregation.alignmentPeriod': `${alignmentSeconds}s`,
      'aggregation.perSeriesAligner': 'ALIGN_MAX',
      'aggregation.crossSeriesReducer': 'REDUCE_MAX',
      'aggregation.groupByFields': ['metric.label.quota_metric'],
    },
  );
  return {
    usageByMetric: reduceSeries(usage, (a, b) => a + b),
    limitByMetric: reduceSeries(limit, (a, b) => Math.max(a, b)),
  };
}

async function collectGoogle(config = {}) {
  const fetchedAt = isoBeijing();
  const label = String(config.label || 'Gemini');
  if (!config.enabled) {
    return { ...failedWindows(label, '未启用', fetchedAt), disabled: true };
  }
  if (config.allowLocalCredentialRead !== true) {
    return failedWindows(label, '未允许读取本机服务账号密钥（allowLocalCredentialRead）', fetchedAt);
  }
  const projectId = String(config.projectId || '').trim();
  if (!projectId) return failedWindows(label, '没有配置 projectId', fetchedAt);

  const service = String(config.service || DEFAULT_SERVICE);
  const now = new Date();
  const interval = {
    startTime: quotaDayStart(now).toISOString(),
    endTime: now.toISOString(),
  };

  try {
    const token = await getAccessToken(config.credentialsFile);
    const { usageByMetric, limitByMetric } = await readQuotaSeries(
      token,
      projectId,
      service,
      interval,
    );
    if (usageByMetric.size === 0) {
      throw new Error(`${service} 在该项目下没有上报配额用量指标，先跑 npm run probe:google 看看有什么`);
    }

    const metricName = pickQuotaMetric(usageByMetric, String(config.quotaMetric || '').trim());
    const usage = metricName == null ? null : usageByMetric.get(metricName);
    if (usage == null) {
      throw new Error(`没有找到 quotaMetric=${metricName} 的用量数据，可选：${[...usageByMetric.keys()].join(', ')}`);
    }

    const configuredLimit = Number(config.dailyLimit);
    const limit = isRealLimit(configuredLimit)
      ? configuredLimit
      : limitByMetric.get(metricName);
    return {
      ok: true,
      label,
      windows: [buildQuotaWindow(usage, limit, isoBeijing(nextQuotaReset(now)))],
      fetchedAt,
      error: null,
    };
  } catch (error) {
    return failedWindows(label, error, fetchedAt);
  }
}

module.exports = {
  DEFAULT_SERVICE,
  LIMIT_METRIC,
  USAGE_METRIC,
  buildQuotaWindow,
  collectGoogle,
  isRealLimit,
  nextQuotaReset,
  pickQuotaMetric,
  quotaDayStart,
  reduceSeries,
  toUsedPct,
};
