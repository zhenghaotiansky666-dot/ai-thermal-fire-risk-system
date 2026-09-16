#!/bin/bash
# 双击即可运行（macOS）：检查环境 → 一键配置本地 AI → 打开系统端
# 如果双击没反应，先在"终端"里执行：chmod +x 启动本地AI.command

cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo " 热感哨兵 · 本地 AI 一键配置（macOS）"
echo "=============================================="

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "❌ 这台电脑还没装 Node.js（运行本项目需要它）。"
  echo "   请打开 https://nodejs.org/zh-cn 下载 macOS 版（选 LTS），装完再双击本文件。"
  echo ""
  echo "按回车键关闭这个窗口。"
  read -r _
  exit 1
fi

echo "· Node 版本：$(node -v)"

if [ ! -d node_modules ]; then
  echo "· 首次运行，正在安装依赖（这一步只做一次，需要联网）…"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install || npm install
  else
    npm install
  fi
fi

if [ ! -d dist ]; then
  echo "· 正在构建站点…"
  (command -v pnpm >/dev/null 2>&1 && pnpm build) || npm run build
fi

echo ""
node tools/setup-local-ai.mjs
status=$?

echo ""
if [ $status -eq 0 ]; then
  echo "✅ 配置完成。上面打印的地址可以直接发给队友/用手机扫码。"
else
  echo "⚠️ 有检查项没通过，请把上面的 ❌ 行连同"怎么修"一起发给项目负责人。"
fi
echo "按回车键关闭这个窗口。"
read -r _
