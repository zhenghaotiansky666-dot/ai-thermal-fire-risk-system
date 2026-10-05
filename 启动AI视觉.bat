@echo off
chcp 65001 >nul
rem 双击即可运行（Windows）：启动队友交付的本地 AI 视觉服务（YOLOv8 火焰/烟雾）

cd /d "%~dp0"

echo ==============================================
echo  FireAegis · 本地 AI 视觉服务（YOLOv8）
echo ==============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [X] 这台电脑没有 python，请先安装 Python 3。
  pause
  exit /b 1
)

python -c "import ultralytics, flask, flask_cors, cv2" >nul 2>nul
if errorlevel 1 (
  echo 首次运行需要安装依赖：
  echo     pip install -r ai\requirements.txt
  echo.
  set /p answer=现在自动安装吗？[y/N] 
  if /i "%answer%"=="y" (
    python -m pip install -r ai\requirements.txt
    if errorlevel 1 (
      echo [X] 安装失败，请把报错发给项目负责人。
      pause
      exit /b 1
    )
  ) else (
    echo 已取消。装好依赖后再双击本文件即可。
    pause
    exit /b 1
  )
)

echo 启动中…（模型 ai\yolov8n.pt，端口 8000）
echo 启动后不要关掉这个窗口；系统端会自动探测到它。
echo.
python ai\server.py --model ai\yolov8n.pt --port 8000

echo.
pause
