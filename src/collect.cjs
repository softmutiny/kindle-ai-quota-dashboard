'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectClaude } = require('./collectors/claude.cjs');
const { collectCodex } = require('./collectors/codex.cjs');
const { collectDeepSeek } = require('./collectors/deepseek.cjs');
const { collectGoogle } = require('./collectors/google.cjs');
const { collectKimi } = require('./collectors/kimi.cjs');
const { ROOT, loadConfig } = require('./lib/config.cjs');
const {
  isoBeijing,
  readJson,
  safeError,
  writeAtomic,
} = require('./lib/common.cjs');

const SOURCE_NAMES = ['claude', 'codex', 'kimi', 'google', 'deepseek'];

function readQuote(filePath) {
  if (!filePath) return null;
  try {
    const value = readJson(filePath);
    if (!value || !value.text) return null;
    return {
      text: String(value.text).slice(0, 180),
      source: String(value.source || '').slice(0, 80),
    };
  } catch {
    return null;
  }
}

function readWeather(filePath) {
  const fetchedAt = isoBeijing();
  if (!filePath) {
    return {
      ok: false,
      description: null,
      iconKey: null,
      tempC: null,
      feelsLikeC: null,
      humidity: null,
      windKph: null,
      windDir: null,
      place: null,
      observedAt: null,
      fetchedAt,
      error: '未配置天气文件',
    };
  }
  try {
    const value = readJson(filePath);
    return {
      ok: true,
      description: String(value.description || '天气').slice(0, 20),
      iconKey: String(value.iconKey || 'cloudy').slice(0, 30),
      tempC: Number.isFinite(Number(value.tempC)) ? Number(value.tempC) : null,
      feelsLikeC: Number.isFinite(Number(value.feelsLikeC)) ? Number(value.feelsLikeC) : null,
      humidity: Number.isFinite(Number(value.humidity)) ? Number(value.humidity) : null,
      windKph: Number.isFinite(Number(value.windKph)) ? Number(value.windKph) : null,
      windDir: String(value.windDir || '').slice(0, 20),
      place: String(value.place || '').slice(0, 30),
      observedAt: isoBeijing(value.observedAt) || fetchedAt,
      fetchedAt,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      description: null,
      iconKey: null,
      tempC: null,
      feelsLikeC: null,
      humidity: null,
      windKph: null,
      windDir: null,
      place: null,
      observedAt: null,
      fetchedAt,
      error: safeError(error),
    };
  }
}

function demoSnapshot() {
  const now = isoBeijing();
  const afterHours = (hours) => isoBeijing(Date.now() + hours * 60 * 60 * 1000);
  return {
    updatedAt: now,
    weather: {
      ok: true,
      description: '晴',
      iconKey: 'clear',
      tempC: 26,
      feelsLikeC: 28,
      humidity: 55,
      windKph: 8,
      windDir: '东南风',
      place: '示例城市',
      observedAt: now,
      fetchedAt: now,
      error: null,
    },
    quote: {
      text: '把无人走过的路，踩成后来人的近路。',
      source: '开源演示',
    },
    sources: {
      claude: {
        ok: true,
        label: 'Claude',
        windows: [
          { name: '5小时', usedPct: 23, resetAt: afterHours(3) },
          { name: '7天', usedPct: 42, resetAt: afterHours(96) },
        ],
        fetchedAt: now,
        error: null,
      },
      codex: {
        ok: true,
        label: 'Codex',
        windows: [{ name: '周', usedPct: 18, resetAt: afterHours(120) }],
        fetchedAt: now,
        error: null,
      },
      kimi: {
        ok: true,
        label: 'Kimi',
        windows: [
          { name: '5小时', usedPct: 35, resetAt: afterHours(4) },
          { name: '周', usedPct: 56, resetAt: afterHours(72) },
        ],
        fetchedAt: now,
        error: null,
      },
      google: {
        ok: true,
        label: 'Gemini',
        windows: [{ name: '每日', usedPct: 6.1, resetAt: afterHours(9), displayValue: '9,150 次' }],
        fetchedAt: now,
        error: null,
      },
      deepseek: {
        ok: true,
        label: 'DeepSeek',
        balance: 12.34,
        currency: 'CNY',
        detail: '余额 ¥12.34',
        fetchedAt: now,
        error: null,
      },
    },
  };
}

async function realSnapshot(config) {
  const providers = config.providers || {};
  const [claude, codex, kimi, google, deepseek] = await Promise.all([
    collectClaude(providers.claude),
    collectCodex(providers.codex),
    collectKimi(providers.kimi),
    collectGoogle(providers.google),
    collectDeepSeek(providers.deepseek),
  ]);
  return {
    updatedAt: isoBeijing(),
    weather: readWeather(config.weatherFile),
    quote: readQuote(config.quoteFile),
    sources: { claude, codex, kimi, google, deepseek },
  };
}

function previousSnapshot(outputDir) {
  try {
    return readJson(path.join(outputDir, 'data.json'));
  } catch {
    return null;
  }
}

function preserveLastKnownGood(snapshot, previous) {
  if (!previous || !previous.sources) return snapshot;
  for (const name of SOURCE_NAMES) {
    const current = snapshot.sources[name];
    const fallback = previous.sources[name];
    if (!current || current.ok || current.disabled || !fallback || !fallback.ok) continue;
    snapshot.sources[name] = {
      ...fallback,
      stale: true,
      lastAttemptAt: current.fetchedAt,
      error: current.error,
    };
  }
  return snapshot;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.updatedAt !== 'string' || !snapshot.sources) {
    throw new Error('快照缺少 updatedAt 或 sources');
  }
  if (!snapshot.weather || typeof snapshot.weather.ok !== 'boolean') {
    throw new Error('快照缺少 weather');
  }
  for (const name of SOURCE_NAMES) {
    const source = snapshot.sources[name];
    if (!source || typeof source.ok !== 'boolean' || typeof source.label !== 'string') {
      throw new Error(`${name} 字段不完整`);
    }
    if (name === 'deepseek') {
      if (!Object.prototype.hasOwnProperty.call(source, 'balance')) {
        throw new Error('deepseek 缺少 balance');
      }
    } else if (!Array.isArray(source.windows)) {
      throw new Error(`${name} 缺少 windows`);
    }
  }
}

function writeSnapshot(snapshot, outputDir, keepLocalHistory) {
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  const javascript = `window.DASH_DATA = ${JSON.stringify(snapshot, null, 2)};\n`;
  writeAtomic(path.join(outputDir, 'data.json'), json);
  writeAtomic(path.join(outputDir, 'data.js'), javascript);
  if (keepLocalHistory) {
    const historyDir = path.join(outputDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.appendFileSync(
      path.join(historyDir, `${snapshot.updatedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify(snapshot)}\n`,
      'utf8',
    );
  }
}

async function main() {
  const demo = process.argv.includes('--demo');
  const config = demo
    ? { outputDir: path.join(ROOT, 'state'), keepLocalHistory: false }
    : loadConfig();
  const previous = demo ? null : previousSnapshot(config.outputDir);
  const fresh = demo ? demoSnapshot() : await realSnapshot(config);
  const snapshot = preserveLastKnownGood(fresh, previous);
  validateSnapshot(snapshot);
  writeSnapshot(snapshot, config.outputDir, config.keepLocalHistory === true);
  const status = SOURCE_NAMES
    .map((name) => `${name}:${snapshot.sources[name].ok ? 'ok' : snapshot.sources[name].disabled ? 'off' : 'fail'}`)
    .join(' ');
  process.stdout.write(`updated ${snapshot.updatedAt} ${status}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  demoSnapshot,
  preserveLastKnownGood,
  readQuote,
  readWeather,
  validateSnapshot,
  writeSnapshot,
};
