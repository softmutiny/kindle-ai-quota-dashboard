#!/bin/sh
# 把 dist/ 同步到 gh-pages 分支并推到 origin。
# gh-pages 只保留一个 commit（每次 amend + 强推），避免十分钟一次的推送把仓库历史撑爆。
set -e

ROOT="$(git rev-parse --show-toplevel)"
WORKTREE="${PAGES_WORKTREE:-$ROOT/../kaqd-pages}"

[ -f "$ROOT/dist/index.html" ] || { echo "dist 不存在，先跑 npm run build" >&2; exit 1; }

if [ ! -d "$WORKTREE/.git" ] && [ ! -f "$WORKTREE/.git" ]; then
  git -C "$ROOT" worktree add -B gh-pages "$WORKTREE"
  git -C "$WORKTREE" rm -rf --ignore-unmatch . >/dev/null 2>&1 || true
fi

# dist 里的文件名是固定的那几个，直接覆盖即可。
cp "$ROOT/dist/index.html" "$ROOT/dist/dashboard-runtime.js" \
   "$ROOT/dist/data.js" "$ROOT/dist/data.json" \
   "$ROOT/dist/live-endpoint.js" "$ROOT/dist/.nojekyll" "$WORKTREE/"

cd "$WORKTREE"
git add -A
git diff --cached --quiet && { echo "没有变化，跳过推送"; exit 0; }

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git commit --amend -m "dashboard snapshot" --date=now >/dev/null
else
  git commit -m "dashboard snapshot" >/dev/null
fi
git push -f origin gh-pages
echo "deployed gh-pages"
