#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

NOTES="改动说明.md"

# ── 防递归：上一个提交已经是发版提交就退出（避免被钩子反复触发）──
if [ -z "$AUTO_RELEASE_FORCE" ]; then
  case "$(git log -1 --pretty=%s 2>/dev/null || echo '')" in
    chore\(release\):*) echo "上一个提交已是发版提交，跳过（如需强制请用 AUTO_RELEASE_FORCE=1）"; exit 0;;
  esac
fi

# ── 参数：./auto-release.sh [版本号|major|minor|patch|--dry-run] ──
ARG="${1:-auto}"
DRY_RUN=0
[ "$ARG" = "--dry-run" ] && { DRY_RUN=1; ARG="auto"; }

CUR=$(git tag --sort=-v:refname 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 | sed 's/^v//')
[ -z "$CUR" ] && CUR="0.0.0"
MAJOR=$(echo "$CUR" | cut -d. -f1)
MINOR=$(echo "$CUR" | cut -d. -f2)
PATCH=$(echo "$CUR" | cut -d. -f3)

git add -A

# 只看「本次新增」的部分
NEW_TEXT=$(git diff --cached --unified=0 -- "$NOTES" | grep '^+' | grep -v '^+++' | sed 's/^+//' || true)

case "$ARG" in
  major|minor|patch)
    [ "$ARG" = major ] && { MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0; }
    [ "$ARG" = minor ] && { MINOR=$((MINOR+1)); PATCH=0; }
    [ "$ARG" = patch ] && PATCH=$((PATCH+1));;
  v[0-9]*|[0-9]*.[0-9]*.[0-9]*)
    NEW="${ARG#v}"; MAJOR="";;
  auto)
    # 默认只升 patch（「新增」二字太常见，不再据此升 minor）
    if echo "$NEW_TEXT" | grep -qE "BREAKING|破坏性|不兼容"; then
      MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0
    elif echo "$NEW_TEXT" | grep -qE "^\s*#{1,3}\s*(v[0-9]|[0-9]+\.[0-9]+)|重大更新"; then
      MINOR=$((MINOR+1)); PATCH=0
    else
      PATCH=$((PATCH+1))
    fi;;
  *) echo "用法: $0 [版本号|major|minor|patch|--dry-run]"; exit 1;;
esac

[ -z "${NEW:-}" ] && NEW="$MAJOR.$MINOR.$PATCH"

if [ "$DRY_RUN" = 1 ]; then
  echo "当前版本: $CUR  →  将要发布: $NEW"; exit 0
fi

# 版本号写回 package.json
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='$NEW';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"

# CHANGELOG 只追加「本次新增」，不再全文叠加
{
  echo ""
  echo "## [$NEW] - $(date +%F)"
  echo ""
  if [ -n "$NEW_TEXT" ]; then
    echo "$NEW_TEXT"
  else
    echo "- 常规更新（详见 $NOTES）"
  fi
} >> CHANGELOG.md

git add package.json CHANGELOG.md "$NOTES"

if ! git diff --cached --quiet; then
  git commit -m "chore(release): v$NEW" -m "$(cat "$NOTES")"
  git tag -a "v$NEW" -m "v$NEW"
  echo "✅ 已发布 v$NEW"
else
  echo "没有需要提交的改动，跳过发版"
fi
