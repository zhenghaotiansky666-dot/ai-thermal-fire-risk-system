#!/bin/bash
# 双击即可运行（macOS）：检查环境 → 构建（如需）→ 启动站点与硬件接收端 → 用独立窗口打开电脑版指挥端
#
# 想固定用某个端口：PORT=4173 HW=8787 ./启动电脑版.command
# 不想自动进监看模式：MONITOR=0 ./启动电脑版.command
#
# 如果双击没反应，先在「终端」里执行：chmod +x 启动电脑版.command

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-4173}"
HW="${HW:-8787}"
MONITOR="${MONITOR:-1}"

echo "=============================================="
echo " 热感哨兵 · 电脑版指挥端（macOS）"
echo "=============================================="

# 有些电脑装了 Node 但没进 PATH（Homebrew、nvm、或用发行包解压的），这里自动找一遍
for candidate in \
  "/opt/homebrew/bin" \
  "/usr/local/bin" \
  "$HOME/.local/bin" \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"; do
  if [ -x "$candidate/node" ]; then
    PATH="$candidate:$PATH"
    export PATH
    break
  fi
done
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  latest_nvm="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
  if [ -n "$latest_nvm" ] && [ -x "$HOME/.nvm/versions/node/$latest_nvm/bin/node" ]; then
    PATH="$HOME/.nvm/versions/node/$latest_nvm/bin:$PATH"
    export PATH
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "❌ 这台电脑还没装 Node.js（运行本项目需要它）。"
  echo "   打开 https://nodejs.org/zh-cn 下载 macOS 版（选 LTS），装完再双击本文件。"
  echo ""
  echo "按回车键关闭这个窗口。"
  read -r _
  exit 1
fi
echo "· Node 版本：$(node -v)"

# 运行包自带 dist；源码包第一次运行会自动装依赖并构建
if [ ! -f dist/index.html ]; then
  if [ ! -d node_modules ]; then
    echo "· 没有预构建的站点，正在安装依赖（只做一次，需要联网）…"
    if command -v pnpm >/dev/null 2>&1; then pnpm install || npm install; else npm install; fi
  fi
  echo "· 正在构建站点…"
  (command -v pnpm >/dev/null 2>&1 && pnpm build) || npm run build
fi

# 硬件接收端（后台运行；没接硬件也不影响）
if node -e "process.exit(0)" >/dev/null 2>&1; then
  node tools/hardware-receiver.mjs --port "$HW" >/tmp/thermal-guard-hardware.log 2>&1 &
  echo "· 硬件接收端：http://127.0.0.1:$HW （日志 /tmp/thermal-guard-hardware.log）"
fi

# 等站点起来再开窗口
URL="http://127.0.0.1:$PORT/mobile-app.html"
[ "$MONITOR" = "1" ] && URL="$URL?monitor=1"

(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/version.json"; then
      if [ -d "/Applications/Google Chrome.app" ]; then
        open -na "Google Chrome" --args --app="$URL" --window-size=1680,1050
      elif [ -d "/Applications/Microsoft Edge.app" ]; then
        open -na "Microsoft Edge" --args --app="$URL" --window-size=1680,1050
      else
        open "$URL"
      fi
      exit 0
    fi
    sleep 0.5
  done
  echo "⚠️ 站点启动超时，请手动打开：$URL"
) &

echo ""
echo "· 电脑版指挥端：$URL"
echo "· 手机/其它设备（同一 Wi-Fi）：启动后会打印局域网地址"
echo ""
echo "▶ 保持这个窗口开着，关掉它服务就停了。"
echo ""

node tools/local-ai-server.mjs --port "$PORT" --hardware-port "$HW"
