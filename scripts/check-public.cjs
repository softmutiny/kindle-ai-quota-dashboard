'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../src/lib/config.cjs');

// 这个检查关心的是「会不会进公开仓库」，而不是「本机有没有这个文件」。
// config.json 之类的文件本来就该存在于本机、且已被 .gitignore 挡下，
// 不排除它们的话，任何人照 README 建完本地配置就再也跑不过 npm run check。
// 判断不了的时候一律当作「没被忽略」，宁可误报也不放过。
function gitIgnoredPaths(paths) {
  if (!paths.length) return new Set();
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: ROOT,
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  if (result.error || result.status > 1) return new Set();
  return new Set(
    String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

const ignoredDirs = new Set([
  '.git',
  'dist',
  'history',
  'logs',
  'node_modules',
  'release',
  'state',
]);
const ignoredFiles = new Set(['package-lock.json']);
const forbiddenNames = [
  /^data\.(?:json|js)$/i,
  /\.jsonl$/i,
  /\.log$/i,
  /\.kpkg$/i,
  /^config\.json$/i,
];
const contentPatterns = [
  { label: 'Windows 私人用户目录', regex: /[A-Za-z]:\\Users\\[^\\\r\n]+\\/i },
  { label: 'macOS/Linux 私人用户目录', regex: /\/(?:Users|home)\/[^/\r\n]+\//i },
  { label: '家庭局域网地址', regex: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { label: 'MAC 地址', regex: /\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/i },
  {
    label: '疑似直接写入的秘密',
    regex: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*["'][A-Za-z0-9_./+=-]{12,}["']/i,
  },
];

function walk(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(fullPath));
    else if (!ignoredFiles.has(entry.name)) output.push(fullPath);
  }
  return output;
}

const problems = [];
const files = walk(ROOT);
const ignored = gitIgnoredPaths(files.map((filePath) => path.relative(ROOT, filePath)));
for (const filePath of files) {
  const relative = path.relative(ROOT, filePath);
  if (relative === path.join('scripts', 'check-public.cjs')) continue;
  const inExamples = relative.startsWith(`examples${path.sep}`);
  if (!inExamples && forbiddenNames.some((pattern) => pattern.test(path.basename(filePath)))) {
    // 已被 git 忽略的运行产物不会进入公开仓库，留在本机是正常的。
    if (ignored.has(relative)) continue;
    problems.push(`${relative}: 不应进入公开仓库的运行产物`);
    continue;
  }
  if (fs.statSync(filePath).size > 2 * 1024 * 1024) {
    problems.push(`${relative}: 文件超过 2 MiB，需人工确认`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const item of contentPatterns) {
    if (item.regex.test(content)) problems.push(`${relative}: ${item.label}`);
  }
}

if (problems.length) {
  process.stderr.write(`公开前检查失败：\n- ${problems.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('公开前检查通过：未发现已知私人路径、运行数据或疑似明文秘密。\n');
}
