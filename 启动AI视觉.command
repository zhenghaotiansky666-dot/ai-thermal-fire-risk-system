#!/bin/bash
# 双击即可运行（macOS）：启动队友交付的本地 AI 视觉服务（YOLOv8 火焰/烟雾）
# 如果双击没反应，先在"终端"里执行：chmod +x 启动AI视觉.command

cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo " FireAegis · 本地 AI 视觉服务（YOLOv8）"
echo "=============================================="
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 这台电脑没有 python3。请先安装 Python 3（https://www.python.org/downloads/）。"
  echo "按回车键关闭这个窗口。"
  read -r _
  exit 1
fi

if ! python3 -c "import ultralytics, flask, flask_cors, cv2" >/dev/null 2>&1; then
  echo "首次运行需要装几个依赖（只做一次，约几百 MB，需要联网）："
  echo ""
  echo "    pip3 install -r ai/requirements.txt"
  echo ""
  read -r -p "现在自动安装吗？[y/N] " answer
  case "$answer" in
    y|Y) python3 -m pip install -r ai/requirements.txt || {
           echo "❌ 安装失败，请把上面的报错发给项目负责人。"
           read -r _
           exit 1
         } ;;
    *) echo "已取消。装好依赖后再双击本文件即可。"; read -r _; exit 1 ;;
  esac
fi

echo "启动中…（模型 ai/yolov8n.pt，端口 8000）"
echo "启动后不要关掉这个窗口；系统端会自动探测到它。"
echo ""
python3 ai/server.py --model ai/yolov8n.pt --port 8000

echo ""
echo "服务已退出。按回车键关闭这个窗口。"
read -r _
