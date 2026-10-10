#!/usr/bin/env bash
# 一键推送到 Gitee / GitLab（本机实测两者直连可用；GitHub 在本机被拦截）
#
# 用法：
#   bash scripts/push-to-git.sh gitee  <你的用户名> <你的token>
#   bash scripts/push-to-git.sh gitlab <你的用户名> <你的token>
#
# 推送前会：
#   1. 把 package.json 里的 USERNAME 占位替换成你的真实用户名
#   2. 跑全套测试 + 安装闸门（不通过就拒绝推送）
#   3. 配置 remote 并推送 main 分支与 tags
#
# 你需要先在网页上建一个**空仓库**（不要勾选初始化 README），
# 再生成一个 **个人访问令牌**（Gitee: 设置→私人令牌；GitLab: 设置→访问令牌，勾 api + write_repository）。

set -euo pipefail

HOST="${1:-}"
USER="${2:-}"
TOKEN="${3:-}"

if [ -z "$HOST" ] || [ -z "$USER" ] || [ -z "$TOKEN" ]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

case "$HOST" in
  gitee)  DOMAIN="gitee.com" ;;
  gitlab) DOMAIN="gitlab.com" ;;
  *) echo "只支持 gitee / gitlab（本机 GitHub 不可达）"; exit 1 ;;
esac

REPO="dsh-think-zh"
cd "$(dirname "$0")/.."

echo "==> 1/4 替换 package.json 里的 USERNAME 占位"
python3 - "$USER" "$DOMAIN" "$REPO" <<'PY'
import json, sys
user, domain, repo = sys.argv[1], sys.argv[2], sys.argv[3]
url = f"https://{domain}/{user}/{repo}"
c = json.load(open('package.json', encoding='utf-8'))
c['repository'] = {'type': 'git', 'url': f"{url}.git"}
c['homepage'] = f"{url}#readme"
c['bugs'] = {'url': f"{url}/issues"}
json.dump(c, open('package.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f"    repository -> {url}.git")
PY

echo "==> 2/4 跑测试与安装闸门"
NODE_BIN="$(command -v node || echo /Users/mac/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node)"
for t in text translator client registration; do
  "$NODE_BIN" "test/$t.test.mjs" >/dev/null
  echo "    $t OK"
done
"$NODE_BIN" scripts/smoke-client.mjs

echo "==> 3/4 提交并配置 remote"
git add -A
git diff --cached --quiet || git commit -q -m "chore: 指向 ${DOMAIN}/${USER}/${REPO}"
git remote remove origin 2>/dev/null || true
git remote add origin "https://${USER}:${TOKEN}@${DOMAIN}/${USER}/${REPO}.git"

echo "==> 4/4 推送"
git push -u origin main
git push origin --tags 2>/dev/null || true

echo
echo "完成：https://${DOMAIN}/${USER}/${REPO}"
echo
echo "注意：token 已写进 .git/config 的 remote 地址里。如果不想留在磁盘上，推送后执行："
echo "  git remote set-url origin https://${DOMAIN}/${USER}/${REPO}.git"
