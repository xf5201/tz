#!/usr/bin/env bash
set -e
cd ~/tz

NOTES="改动说明.md"

# 1. 暂存所有改动
git add -A

# 2. 版本号以「最新 tag」为准，不再依赖 package.json
CUR=$(git tag --sort=-v:refname 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 | sed 's/^v//')
[ -z "$CUR" ] && CUR="0.0.0"
MAJOR=$(echo "$CUR" | cut -d. -f1)
MINOR=$(echo "$CUR" | cut -d. -f2)
PATCH=$(echo "$CUR" | cut -d. -f3)

# 3. 只看本次改动说明里「新增的部分」判断升哪一位
NEW_TEXT=$(git diff --cached --unified=0 -- "$NOTES" | grep '^+' | grep -v '^+++' || true)
[ -z "$NEW_TEXT" ] && NEW_TEXT=$(cat "$NOTES" 2>/dev/null || echo "")

if echo "$NEW_TEXT" | grep -qE "BREAKING|破坏性|不兼容"; then
  MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0
elif echo "$NEW_TEXT" | grep -qE "新增|Features|feat:|新功能"; then
  MINOR=$((MINOR+1)); PATCH=0
else
  PATCH=$((PATCH+1))
fi
NEW="$MAJOR.$MINOR.$PATCH"

# 4. 版本号写回 package.json
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='$NEW';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"

# 5. 追加进 CHANGELOG.md
{
  echo ""
  echo "## [$NEW] - $(date +%F)"
  echo ""
  cat "$NOTES"
} >> CHANGELOG.md

git add package.json CHANGELOG.md "$NOTES"

# 6. 提交并打 tag
if ! git diff --cached --quiet; then
  git commit -m "chore(release): v$NEW" -m "$(cat "$NOTES")"
  git tag -a "v$NEW" -m "v$NEW"
else
  echo "没有需要提交的改动，跳过发版"
fi
