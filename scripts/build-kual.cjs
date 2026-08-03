'use strict';

// 生成 KUAL 扩展目录（给没有 KPM、只有 KUAL 的设备用）。
// 产物：release/aiquota/，整个目录拷到 Kindle 的 /mnt/us/extensions/ 下即可。
// 需要 DASHBOARD_URL。

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../src/lib/config.cjs');

const dashboardUrl = String(process.env.DASHBOARD_URL || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^?#\s]+$/i.test(dashboardUrl)) {
  throw new Error('先设置 DASHBOARD_URL，且地址不能包含查询参数或片段。');
}

const outputDir = path.join(ROOT, 'release', 'aiquota');
const binDir = path.join(outputDir, 'bin');
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });

const write = (name, content) => {
  const target = path.join(binDir, name);
  fs.writeFileSync(target, content, 'utf8');
  fs.chmodSync(target, 0o755);
};

// 浏览器启动器直接复用仓库里那份，它不依赖 KPM。
fs.copyFileSync(
  path.join(ROOT, 'kindle', 'package', 'payload', 'dashboard_browser.sh'),
  path.join(binDir, 'dashboard_browser.sh'),
);
fs.chmodSync(path.join(binDir, 'dashboard_browser.sh'), 0o755);

write('launch.sh', `#!/bin/sh
# 启动全屏中控台。KPM 版本走 "kpm launch"，这里直接调浏览器脚本。
HERE="$(dirname "$0")"
lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1 || true
battery="$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)"
exec /bin/bash "$HERE/dashboard_browser.sh" "${dashboardUrl}?battery=\${battery}"
`);

write('stop.sh', `#!/bin/sh
# 强制恢复 Kindle 原生界面。全屏浏览器卡住时用这个救场。
lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1 || true
killall kindle_browser >/dev/null 2>&1 || true
if [ -d /etc/upstart ]; then
  status lab126_gui 2>/dev/null | grep -q running || start lab126_gui >/dev/null 2>&1 || true
  usleep 1250000
else
  /etc/init.d/framework start >/dev/null 2>&1 || true
fi
eips -c >/dev/null 2>&1
eips -c >/dev/null 2>&1
exit 0
`);

write('diag.sh', `#!/bin/sh
# 设备自检：把部署前需要确认的信息写到 /mnt/us/aiquota-report.txt。
# 只读，不改动任何系统状态。
OUT="/mnt/us/aiquota-report.txt"

{
  echo "== 时间 =="
  date
  echo
  echo "== 固件与机型 =="
  cat /etc/prettyversion.txt 2>/dev/null || echo "(无 prettyversion.txt)"
  cat /etc/version.txt 2>/dev/null
  uname -a
  echo
  echo "== Chromium 浏览器是否存在（决定能否全屏）=="
  if [ -x /usr/bin/chromium/bin/kindle_browser ]; then
    echo "YES /usr/bin/chromium/bin/kindle_browser"
  else
    echo "NO  /usr/bin/chromium/bin/kindle_browser 不存在或不可执行"
    echo "-- 系统里其它可能的浏览器 --"
    ls -d /usr/bin/chromium 2>/dev/null
    ls /usr/bin/*browser* 2>/dev/null
    ls -d /opt/amazon/ebook/booklet/browser* 2>/dev/null
  fi
  echo
  echo "== 屏幕分辨率（决定要不要改 600x800 布局）=="
  cat /sys/class/graphics/fb0/virtual_size 2>/dev/null || echo "(读不到 fb0)"
  eips -i 2>/dev/null | head -20
  echo
  echo "== 恢复 GUI 所需的工具 =="
  for tool in eips lipc-set-prop lipc-get-prop killall; do
    if command -v "\$tool" >/dev/null 2>&1; then echo "YES \$tool"; else echo "NO  \$tool"; fi
  done
  echo "init 体系: \$([ -d /etc/upstart ] && echo upstart || echo sysvinit)"
  echo
  echo "== GUI 服务当前状态 =="
  status lab126_gui 2>/dev/null || echo "(status 命令不可用)"
  echo
  echo "== 网络 =="
  lipc-get-prop com.lab126.wifid cmState 2>/dev/null || echo "(读不到 wifi 状态)"
  echo
  echo "== 电量 =="
  lipc-get-prop com.lab126.powerd battLevel 2>/dev/null
} > "\$OUT" 2>&1

sync
eips -c >/dev/null 2>&1
eips 5 20 "self-check done -> aiquota-report.txt" >/dev/null 2>&1
exit 0
`);

fs.writeFileSync(path.join(outputDir, 'menu.json'), `${JSON.stringify({
  items: [
    { name: '启动 AI 额度中控台', priority: 0, action: 'bin/launch.sh', exitmenu: true },
    { name: '退出中控台 / 恢复界面', priority: 1, action: 'bin/stop.sh', exitmenu: true },
    { name: '设备自检', priority: 2, action: 'bin/diag.sh', exitmenu: false },
  ],
}, null, 2)}\n`, 'utf8');

process.stdout.write(`built ${outputDir}\n`);
