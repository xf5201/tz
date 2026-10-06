#!/usr/bin/env bash
set -e
cd ~/tz

NOTES="改动说明.md"

# 1. 暂存所有改动（新增的改动说明.md 也会被收进来）
git add -A

# 2. 读当前版本
CUR=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
MAJOR=$(echo "$CUR" | cut -d. -f1)
MINOR=$(echo "$CUR" | cut -d. -f2)
PATCH=$(echo "$CUR" | cut -d. -f3)

# 3. 按改动说明里的关键词决定升哪一位
TEXT=$(cat "$NOTES" 2>/dev/null || echo "")
if echo "$TEXT" | grep -qE "BREAKING|破坏性|不兼容"; then
  MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0
elif echo "$TEXT" | grep -qE "新增|Features|feat:|新功能"; then
  MINOR=$((MINOR+1)); PATCH=0
else
  PATCH=$((PATCH+1))
fi
NEW="$MAJOR.$MINOR.$PATCH"

# 4. 写回 package.json（用 node 保证 JSON 合法）
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.version='$NEW';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
"

# 5. 把改动说明追加进 CHANGELOG.md
{
  echo ""
  echo "## [$NEW] - $(date +%F)"
  echo ""
  cat "$NOTES"
} >> CHANGELOG.md

git add package.json CHANGELOG.md "$NOTES"

# 6. 提交（版本号在标题，改动说明在正文）并打 tag
if ! git diff --cached --quiet; then
  git commit -m "chore(release): v$NEW" -m "$(cat "$NOTES")"
  git tag -a "v$NEW" -m "v$NEW"
fi
