@echo off
chcp 65001 >nul
rem 双击即可运行（Windows）：检查环境 → 构建（如需）→ 启动站点与硬件接收端 → 用独立窗口打开电脑版指挥端
rem 想换端口：set PORT=4173 & set HW=8787 & 启动电脑版.bat

cd /d "%~dp0"
if "%PORT%"=="" set PORT=4173
if "%HW%"=="" set HW=8787
if "%MONITOR%"=="" set MONITOR=1

echo ==============================================
echo  FireAegis · 电脑版指挥端（Windows）
echo ==============================================

where node >nul 2>nul
if errorlevel 1 (
  rem 有些电脑装了 Node 但没进 PATH，这里补上常见位置
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] 这台电脑还没装 Node.js（运行本项目需要它）。
  echo     1 - 用 winget 自动安装（推荐，Windows 10/11 自带）
  echo     2 - 打开官网下载页手动安装
  echo     0 - 退出
  echo.
  set /p CHOICE=请输入数字后回车：
  if "%CHOICE%"=="1" (
    where winget >nul 2>nul
    if errorlevel 1 (
      start https://nodejs.org/zh-cn
    ) else (
      winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    )
  ) else if "%CHOICE%"=="2" (
    start https://nodejs.org/zh-cn
  )
  echo.
  echo 装完 Node.js 后请重新双击本文件。
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo · Node 版本：%%v

if not exist dist\index.html (
  if not exist node_modules (
    echo · 没有预构建的站点，正在安装依赖（只做一次，需要联网）…
    call npm install
  )
  echo · 正在构建站点…
  call npm run build
)

start "FireAegis-硬件接收端" /min cmd /c "node tools\hardware-receiver.mjs --port %HW%"
echo · 硬件接收端：http://127.0.0.1:%HW%

set URL=http://127.0.0.1:%PORT%/mobile-app.html
if "%MONITOR%"=="1" set URL=%URL%?monitor=1

echo · 正在启动站点…
start "FireAegis-站点" /min cmd /c "node tools\local-ai-server.mjs --port %PORT% --hardware-port %HW%"

echo · 等待站点就绪…
timeout /t 6 /nobreak >nul

set CHROME=
for %%p in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do if exist %%p if "%CHROME%"=="" set CHROME=%%p

if "%CHROME%"=="" (
  start "" "%URL%"
) else (
  start "" %CHROME% --app="%URL%" --window-size=1680,1050
)

echo.
echo · 电脑版指挥端：%URL%
echo · 手机/其它设备（同一 Wi-Fi）：站点窗口里会打印局域网地址与二维码
echo.
echo 站点与硬件接收端已在后台运行；要停止请关闭那两个最小化的窗口。
pause
