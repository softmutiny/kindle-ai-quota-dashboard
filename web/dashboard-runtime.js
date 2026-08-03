(function (win, doc) {
  'use strict';

  var settings = {
    fallbackData: 'data.js',
    endpointPointer: 'live-endpoint.js',
    pollEvery: 3 * 60 * 1000,
    pollOffset: 5000,
    quietStart: 3,
    quietEnd: 8
  };
  var state = {
    endpoint: win.DASH_LIVE_ENDPOINT || settings.fallbackData,
    latest: null,
    renderedAt: ''
  };
  var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var ui = {
    find: function (id) {
      return doc.getElementById(id);
    },
    textNode: function (node, value) {
      var next = String(value);
      if (node && node.textContent !== next) node.textContent = next;
    },
    text: function (id, value) {
      ui.textNode(ui.find(id), value);
    },
    html: function (node, value) {
      if (node && node.innerHTML !== value) node.innerHTML = value;
    },
    className: function (node, value) {
      if (node && node.className !== value) node.className = value;
    },
    style: function (node, name, value) {
      if (node && node.style[name] !== value) node.style[name] = value;
    },
    attribute: function (node, name, value) {
      var next = String(value);
      if (node && node.getAttribute(name) !== next) node.setAttribute(name, next);
    }
  };

  function twoDigits(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function timestamp(value) {
    var parsed = Date.parse(value || '');
    return isNaN(parsed) ? 0 : parsed;
  }

  function clockText(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '--:--';
    return twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes());
  }

  function isQuiet(date) {
    var hour = (date || new Date()).getHours();
    return hour >= settings.quietStart && hour < settings.quietEnd;
  }

  function millisecondsUntilMorning(date) {
    var now = date || new Date();
    var morning = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      settings.quietEnd,
      0,
      5,
      0
    );
    return Math.max(1000, morning.getTime() - now.getTime());
  }

  function updateFreshness() {
    var lastUpdate = state.latest && state.latest.updatedAt;
    var age = lastUpdate
      ? Math.floor((Date.now() - timestamp(lastUpdate)) / 60000)
      : 99999;
    var lastClock = clockText(lastUpdate);
    var status = ui.find('dataStatus');
    var alert = ui.find('dataAlert');

    if (state.latest) {
      ui.text('relTime', age < 1 ? '刚刚更新' : age + '分钟前更新');
    }

    if (isQuiet()) {
      ui.textNode(status, '夜间省电 · 08:00恢复');
      ui.className(status, '');
      ui.textNode(alert, '');
      ui.className(alert, 'data-alert');
      return;
    }

    if (!state.latest || age > 15) {
      ui.textNode(status, '离线 · 最后 ' + lastClock);
      ui.className(status, 'warn');
      ui.textNode(alert, '电脑或数据链路已离线 · 最后在线 ' + lastClock);
      ui.className(alert, 'data-alert on');
      return;
    }

    if (age >= 7) {
      ui.textNode(status, '延迟 ' + age + ' 分钟 · ' + lastClock);
      ui.className(status, 'warn');
      ui.textNode(alert, '实时数据延迟 ' + age + ' 分钟 · 正在显示最后一次结果');
      ui.className(alert, 'data-alert on');
      return;
    }

    ui.textNode(status, '实时 · ' + lastClock);
    ui.className(status, '');
    ui.textNode(alert, '');
    ui.className(alert, 'data-alert');
  }

  function updateClock() {
    var now = new Date();
    ui.text('dtTime', twoDigits(now.getHours()) + ':' + twoDigits(now.getMinutes()));
    ui.text('dtDate', now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日');
    ui.text('dtWeek', weekdays[now.getDay()]);
    updateFreshness();
  }

  function queryValue(name) {
    var match = String(location.search || '').match(
      new RegExp('[?&]' + name + '=([^&]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function updateBattery() {
    var percentText = queryValue('battery');
    var chargeText = queryValue('charging');
    var percent = percentText !== null ? Number(percentText) : null;
    var charging = chargeText === '1';
    var device = win.KINDLE_DEVICE;

    if (device) {
      if (typeof device.battery === 'number') percent = device.battery;
      if (typeof device.charging === 'boolean') charging = device.charging;
      if (device.charging === 0 || device.charging === 1) charging = device.charging === 1;
    }
    if (percent === null || isNaN(percent)) return;

    percent = Math.max(0, Math.min(100, percent));
    ui.text('batPct', (charging ? '⚡ ' : '') + percent + '%');
    ui.attribute(ui.find('batFill'), 'width', Math.round(18 * percent / 100));
  }

  function attachScript(url, onSuccess, onFailure) {
    var script = doc.createElement('script');
    script.async = true;
    script.src = url;
    script.onload = function () {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (onSuccess) onSuccess();
    };
    script.onerror = function () {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (onFailure) onFailure();
    };
    doc.getElementsByTagName('head')[0].appendChild(script);
  }

  function requestDeviceStatus() {
    attachScript('device-status.js?_=' + Date.now(), updateBattery);
  }

  function windowTitle(value) {
    var name = String(value || '');
    if (/5小时|5H/i.test(name)) return '5H QUOTA';
    if (/7天|周|WEEK/i.test(name)) return 'WEEKLY';
    if (/月|MONTH/i.test(name)) return 'MONTHLY';
    if (/每日|日|DAILY/i.test(name)) return 'DAILY';
    return name || 'QUOTA';
  }

  function remainingTime(value) {
    var remaining = timestamp(value) - Date.now();
    var minutes;
    var days;
    var hours;
    if (!value || !remaining) return '↻ 未提供刷新时间';
    if (remaining <= 0) return '↻ 即将刷新';

    minutes = Math.ceil(remaining / 60000);
    days = Math.floor(minutes / 1440);
    hours = Math.floor((minutes % 1440) / 60);
    minutes %= 60;
    if (days) return '↻ ' + days + 'd' + (hours ? ' ' + hours + 'h' : '');
    if (hours) return '↻ ' + hours + 'h' + twoDigits(minutes) + 'm';
    return '↻ ' + minutes + 'm';
  }

  function showUnavailableQuota(rows) {
    var labels;
    if (!rows.length) return;
    ui.style(rows[0], 'display', 'block');
    labels = rows[0].querySelectorAll('.q-label span');
    if (labels.length > 1) {
      ui.textNode(labels[0], '获取失败');
      ui.textNode(labels[1], '--');
    }
    ui.style(rows[0].querySelector('.q-bar-fill'), 'width', '0%');
    ui.textNode(rows[0].querySelector('.q-refresh'), '↻ 等待下次采集');
  }

  function updateQuotaCard(cardId, source) {
    var card = ui.find(cardId);
    var rows;
    var windows;
    var index;
    if (!card) return;

    rows = card.querySelectorAll('.q-row');
    windows = source && source.ok && source.windows ? source.windows : [];
    for (index = 0; index < rows.length; index += 1) {
      var quotaWindow;
      var labels;
      var percentage;
      if (index >= windows.length) {
        ui.style(rows[index], 'display', 'none');
        continue;
      }

      quotaWindow = windows[index];
      ui.style(rows[index], 'display', 'block');
      labels = rows[index].querySelectorAll('.q-label span');
      if (labels.length > 1) {
        ui.textNode(labels[0], windowTitle(quotaWindow.name));
        ui.textNode(
          labels[1],
          quotaWindow.displayValue != null
            ? String(quotaWindow.displayValue)
            : Math.round(Number(quotaWindow.usedPct) || 0) + '%'
        );
      }

      percentage = quotaWindow.barPct != null
        ? quotaWindow.barPct
        : quotaWindow.usedPct;
      ui.style(
        rows[index].querySelector('.q-bar-fill'),
        'width',
        Math.max(0, Math.min(100, Number(percentage) || 0)) + '%'
      );
      ui.textNode(
        rows[index].querySelector('.q-refresh'),
        quotaWindow.detailText || remainingTime(quotaWindow.resetAt)
      );
    }
    if (!windows.length) showUnavailableQuota(rows);
  }

  function selectWeatherIcon(key, description) {
    var text = (String(key || '') + ' ' + String(description || '')).toLowerCase();
    if (/thunder|雷/.test(text)) return 'ϟ';
    if (/snow|雪/.test(text)) return '❄';
    if (/rain|wet|雨/.test(text)) return '☂';
    if (/fog|mist|haze|雾/.test(text)) return '≋';
    if (/clear|sun|晴/.test(text)) return '☀';
    return '☁';
  }

  function updateWeather(weather) {
    if (!weather || !weather.ok) return;
    ui.text('weatherTemp', Math.round(Number(weather.tempC)) + '°');
    ui.html(
      ui.find('weatherIcon'),
      '<span style="font-size:30px;line-height:1">' +
        selectWeatherIcon(weather.iconKey, weather.description) +
      '</span>'
    );
    ui.html(
      ui.find('weatherDetail'),
      String(weather.description || '天气') +
        ' · 体感 ' + Math.round(Number(weather.feelsLikeC)) +
        '° · 湿度 ' + Math.round(Number(weather.humidity)) +
        '%<br>风 ' + Math.round(Number(weather.windKph)) +
        'km/h · ' + String(weather.place || '北京')
    );
  }

  function updateBalance(source) {
    if (source && source.ok && typeof source.balance === 'number') {
      ui.text('deepSeekBalance', '¥ ' + Number(source.balance).toFixed(2));
      ui.text('deepSeekDetail', '实时余额 · 按量计费');
      return;
    }
    ui.text('deepSeekBalance', '¥ --');
    ui.text('deepSeekDetail', '获取失败 · 等待下次采集');
  }

  function updateQuote(quote) {
    if (!quote || !quote.text) return;
    ui.textNode(doc.querySelector('.quote-text'), quote.text);
    if (quote.source) {
      ui.textNode(doc.querySelector('.quote-src'), '— ' + quote.source);
    }
  }

  function present(data) {
    var relativeNode;
    if (!data || !data.updatedAt || !data.sources) return;
    if (state.renderedAt && timestamp(data.updatedAt) < timestamp(state.renderedAt)) return;

    state.latest = data;
    if (data.updatedAt !== state.renderedAt) {
      state.renderedAt = data.updatedAt;
      updateWeather(data.weather);
      updateQuotaCard('cardClaude', data.sources.claude);
      updateQuotaCard('cardCodex', data.sources.codex);
      updateQuotaCard('cardGoogle', data.sources.google);
      updateBalance(data.sources.deepseek);
      updateQuote(data.quote);
      relativeNode = ui.find('relTime');
      if (relativeNode) ui.attribute(relativeNode, 'data-ts', data.updatedAt);
    }
    updateFreshness();
  }

  function requestData(url, canFallback) {
    var separator;
    if (!url || url.indexOf('__LIVE_') === 0) return;
    separator = url.indexOf('?') < 0 ? '?' : '&';
    attachScript(
      url + separator + '_=' + Date.now(),
      function () {
        present(win.DASH_DATA);
      },
      function () {
        if (canFallback && url !== settings.fallbackData) {
          requestData(settings.fallbackData, false);
        }
      }
    );
  }

  function refresh() {
    requestDeviceStatus();
    attachScript(
      settings.endpointPointer + '?_=' + Date.now(),
      function () {
        var supplied = win.DASH_LIVE_ENDPOINT || '';
        if (supplied && supplied.indexOf('__LIVE_') !== 0) state.endpoint = supplied;
        requestData(state.endpoint, true);
      },
      function () {
        state.endpoint = settings.fallbackData;
        requestData(state.endpoint, false);
      }
    );
  }

  function scheduleRefresh() {
    var now = new Date();
    var milliseconds = now.getTime();
    var delay;

    if (isQuiet(now)) {
      delay = millisecondsUntilMorning(now);
    } else {
      delay = (
        settings.pollOffset -
        (milliseconds % settings.pollEvery) +
        settings.pollEvery
      ) % settings.pollEvery;
      if (delay < 250) delay += settings.pollEvery;
    }

    setTimeout(function () {
      if (!isQuiet()) refresh();
      scheduleRefresh();
    }, delay);
  }

  function scheduleMinuteClock() {
    var now = new Date();
    var delay = isQuiet(now)
      ? millisecondsUntilMorning(now)
      : 60000 - (now.getTime() % 60000) + 100;
    setTimeout(function () {
      updateClock();
      scheduleMinuteClock();
    }, delay);
  }

  present(win.DASH_DATA);
  updateClock();
  updateBattery();
  if (!isQuiet()) refresh();
  scheduleRefresh();
  scheduleMinuteClock();
}(window, document));
