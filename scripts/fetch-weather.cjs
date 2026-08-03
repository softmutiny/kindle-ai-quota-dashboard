'use strict';

// 从 wttr.in 抓当前天气，写成采集器认识的 config/weather.json。
// 城市用环境变量 WEATHER_CITY 指定，默认迪拜。

const path = require('node:path');
const { ROOT } = require('../src/lib/config.cjs');
const { fetchJson, isoBeijing, writeAtomic } = require('../src/lib/common.cjs');

const city = String(process.env.WEATHER_CITY || 'Dubai').trim();
const outputFile = path.resolve(ROOT, process.env.WEATHER_FILE || 'config/weather.json');

// WWO 天气代码 → 前端图标关键字 + 中文描述。
// 图标关键字必须命中 dashboard-runtime.js 里 selectWeatherIcon 的正则：
// thunder / snow / rain / fog / clear，其余一律落到云图标。
const CODES = {
  113: ['clear', '晴'],
  116: ['cloudy', '多云'],
  119: ['cloudy', '阴'],
  122: ['cloudy', '阴'],
  143: ['fog', '薄雾'],
  176: ['rain', '局部有雨'],
  179: ['snow', '局部有雪'],
  182: ['snow', '局部雨夹雪'],
  185: ['rain', '局部冻毛毛雨'],
  200: ['thunder', '有雷阵雨'],
  227: ['snow', '吹雪'],
  230: ['snow', '暴风雪'],
  248: ['fog', '雾'],
  260: ['fog', '冻雾'],
  263: ['rain', '零星小毛雨'],
  266: ['rain', '小毛雨'],
  281: ['rain', '冻毛毛雨'],
  284: ['rain', '强冻毛毛雨'],
  293: ['rain', '零星小雨'],
  296: ['rain', '小雨'],
  299: ['rain', '间歇中雨'],
  302: ['rain', '中雨'],
  305: ['rain', '间歇大雨'],
  308: ['rain', '大雨'],
  311: ['rain', '小冻雨'],
  314: ['rain', '强冻雨'],
  317: ['snow', '小雨夹雪'],
  320: ['snow', '雨夹雪'],
  323: ['snow', '零星小雪'],
  326: ['snow', '小雪'],
  329: ['snow', '零星中雪'],
  332: ['snow', '中雪'],
  335: ['snow', '零星大雪'],
  338: ['snow', '大雪'],
  350: ['snow', '冰粒'],
  353: ['rain', '小阵雨'],
  356: ['rain', '阵雨'],
  359: ['rain', '暴雨'],
  362: ['snow', '小阵雨夹雪'],
  365: ['snow', '阵雨夹雪'],
  368: ['snow', '小阵雪'],
  371: ['snow', '阵雪'],
  374: ['snow', '小冰粒'],
  377: ['snow', '冰粒'],
  386: ['thunder', '雷阵雨'],
  389: ['thunder', '强雷阵雨'],
  392: ['thunder', '雷阵雪'],
  395: ['thunder', '强雷阵雪'],
};

const WIND_DIRS = {
  N: '北风', NNE: '北偏东风', NE: '东北风', ENE: '东偏北风',
  E: '东风', ESE: '东偏南风', SE: '东南风', SSE: '南偏东风',
  S: '南风', SSW: '南偏西风', SW: '西南风', WSW: '西偏南风',
  W: '西风', WNW: '西偏北风', NW: '西北风', NNW: '北偏西风',
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const payload = await fetchJson(
    `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
    { headers: { 'user-agent': 'kindle-ai-quota-dashboard/0.1' }, timeoutMs: 20_000 },
  );
  const current = payload && payload.current_condition && payload.current_condition[0];
  if (!current) throw new Error('wttr.in 没有返回 current_condition');

  const [iconKey, description] = CODES[Number(current.weatherCode)]
    || ['cloudy', String(current.weatherDesc && current.weatherDesc[0] && current.weatherDesc[0].value || '天气')];
  const area = payload.nearest_area && payload.nearest_area[0];
  const place = String(area && area.areaName && area.areaName[0] && area.areaName[0].value || city);

  writeAtomic(outputFile, `${JSON.stringify({
    description,
    iconKey,
    tempC: number(current.temp_C),
    feelsLikeC: number(current.FeelsLikeC),
    humidity: number(current.humidity),
    windKph: number(current.windspeedKmph),
    windDir: WIND_DIRS[String(current.winddir16Point || '').toUpperCase()] || '',
    place: place === 'Dubai' ? '迪拜' : place,
    observedAt: isoBeijing(current.localObsDateTime || undefined),
  }, null, 2)}\n`);

  process.stdout.write(`weather ${place} ${current.temp_C}°C ${description}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
