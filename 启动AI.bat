@echo off
chcp 65001 >nul
rem 双击即可运行（Windows）：一键装好并启动 FireAegis 的本地 AI

cd /d "%~dp0"
echo ==============================================
echo  FireAegis · 本地 AI 一键启动
echo ==============================================
echo.

rem ---------- 1. Ollama ----------
where ollama >nul 2>nul
if errorlevel 1 (
  if exist "ollama离线.zip" (
    echo · 解压包内的离线 Ollama 安装包…
    if not exist "_ollama_tmp" mkdir _ollama_tmp
    powershell -Command "Expand-Archive -Force 'ollama离线.zip' '_ollama_tmp'" >nul 2>nul
    if exist "_ollama_tmp\OllamaSetup.exe" (
      echo   正在安装 Ollama（会弹出安装程序，请点 Install）…
      start /wait "" "_ollama_tmp\OllamaSetup.exe"
    )
  ) else (
    echo · 没找到 Ollama，正在从官网下载（约 700MB，需要联网）…
    powershell -Command "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile 'OllamaSetup.exe'" 2>nul
    if exist "OllamaSetup.exe" (
      echo   正在安装 Ollama（会弹出安装程序，请点 Install）…
      start /wait "" "OllamaSetup.exe"
    )
  )
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo [X] Ollama 没装成功，决策模型暂时不可用（视觉 AI 不受影响）。
) else (
  echo · Ollama 就绪
  curl -s -m 2 http://127.0.0.1:11434/api/tags >nul 2>nul
  if errorlevel 1 (
    echo   启动 ollama serve（后台）…
    start "FireAegis-Ollama" /min cmd /c "ollama serve > ollama.log 2>&1"
    timeout /t 8 /nobreak >nul
  )
  ollama list | findstr /i "fireaegis" >nul
  if errorlevel 1 (
    if exist "models\qwen2.5-3b-instruct.gguf" (
      echo · 正在导入决策模型 fireaegis（1.9GB，第一次约 1 分钟）…
      ollama create fireaegis -f ai\Modelfile.fireaegis
    ) else (
      echo [X] 没找到 models\qwen2.5-3b-instruct.gguf，跳过决策模型。
    )
  ) else (
    echo · 决策模型 fireaegis 已在
  )
)
echo.

rem ---------- 2. 视觉模型 ----------
where python >nul 2>nul
if errorlevel 1 (
  echo [X] 这台电脑没有 python，视觉模型无法启动（装好 Python 3 后重跑本文件）。
) else (
  python -c "import ultralytics, flask, flask_cors" >nul 2>nul
  if errorlevel 1 (
    echo · 首次运行需要装视觉依赖（约几百 MB，需要联网）…
    python -m pip install -q -r ai\requirements.txt
  )
  curl -s -m 2 http://127.0.0.1:8000/health >nul 2>nul
  if errorlevel 1 (
    echo · 启动视觉服务（YOLO + ai\best.pt，端口 8000）…
    start "FireAegis-视觉服务" /min cmd /c "python ai\server.py --model ai\best.pt --port 8000 --no-camera > 视觉服务.log 2>&1"
    timeout /t 10 /nobreak >nul
  )
  curl -s -m 3 http://127.0.0.1:8000/health >nul 2>nul
  if errorlevel 1 (echo [X] 视觉服务没起来，日志见 视觉服务.log) else (echo · 视觉服务已就绪：http://127.0.0.1:8000)
)

echo.
echo ==============================================
echo  AI 启动完成，现在可以双击「启动电脑版」打开系统端
echo ==============================================
pause
