#!/usr/bin/env bash
# 一条命令把中继部署到 Cloudflare（免费额度），并打印可以直接填进前端的频道地址。
#
# 前置：你本人已经注册并登录 Cloudflare（这一步必须你自己做，脚本不会替你注册账号）。
#   npm i -g wrangler && wrangler login
#
# 用法：
#   bash tools/deploy-cloudflare.sh                 # 使用默认项目名 thermal-guard-relay
#   bash tools/deploy-cloudflare.sh aifiredetection # 自定义 Worker 名称（会体现在免费子域里）
#
# 脚本会：检查 wrangler 与登录状态 → 复用或创建 KV → 写入 tools/wrangler.toml → 部署 → 打印频道地址

set -euo pipefail

WORKER_NAME="${1:-thermal-guard-relay}"
CONFIG="tools/wrangler.toml"
KV_BINDING="TG_EVENTS"

echo "== 1/5 检查 wrangler =="
if ! command -v wrangler >/dev/null 2>&1; then
  echo "没有找到 wrangler。先执行：npm i -g wrangler"
  exit 1
fi
wrangler --version

echo "== 2/5 检查登录状态 =="
if ! wrangler whoami >/dev/null 2>&1; then
  echo "还没有登录 Cloudflare。接下来会打开浏览器，请用你自己的账号登录（免费注册）。"
  wrangler login
fi
wrangler whoami | sed -n '1,8p'

echo "== 3/5 准备 KV 命名空间 =="
KV_LIST="$(wrangler kv namespace list 2>/dev/null || echo '[]')"
KV_ID="$(printf '%s' "$KV_LIST" | grep -o "\"id\"[^,]*" | head -1 | sed 's/.*: *"//; s/"$//' || true)"

if [ -z "${KV_ID:-}" ]; then
  echo "没有现成的 KV，创建一个新的…"
  CREATE_OUT="$(wrangler kv namespace create "$KV_BINDING" 2>&1 || true)"
  echo "$CREATE_OUT"
  KV_ID="$(printf '%s' "$CREATE_OUT" | grep -o 'id = "[^"]*"' | head -1 | sed 's/id = "//; s/"$//')"
fi

if [ -z "${KV_ID:-}" ]; then
  echo "没能自动拿到 KV id。请手动执行 wrangler kv namespace create $KV_BINDING，"
  echo "把返回的 id 填进 $CONFIG 的 kv_namespaces.id 之后重跑本脚本。"
  exit 1
fi
echo "KV id: $KV_ID"

echo "== 4/5 写入配置并部署 =="
python3 - "$CONFIG" "$WORKER_NAME" "$KV_ID" <<'PY'
import re, sys
path, name, kv_id = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
text = re.sub(r'^name = ".*"$', f'name = "{name}"', text, flags=re.M)
text = re.sub(r'(\{\s*binding = "TG_EVENTS",\s*id = ")[^"]*(")', rf'\g<1>{kv_id}\g<2>', text)
open(path, 'w', encoding='utf-8').write(text)
print(f'已更新 {path}')
PY

cd "$(dirname "$0")/.."
wrangler deploy tools/relay-worker.mjs --config tools/wrangler.toml

echo "== 5/5 完成 =="
cat <<EOF

部署完成。接下来把下面这行填到两端「云端通道」（系统端顶栏「链路」/ 用户端「更多 → 离线联通」）：

  https://${WORKER_NAME}.<你的 workers 子域>.workers.dev#campus

说明：
  · 具体子域在 wrangler deploy 的输出里（形如 https://xxx.workers.dev）
  · 结尾的 #campus 是分组名，不同楼栋/小区换成不同名字即可互不干扰
  · 想让它成为默认通道：把上面这行填进 public/ai-config.json 的 cloudChannel 后重新构建部署

自测：
  curl "https://<你的子域>.workers.dev/health?topic=campus"
EOF
