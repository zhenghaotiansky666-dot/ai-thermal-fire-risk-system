@echo off
chcp 65001 >nul
rem 双击即可运行（Windows）：检查环境 → 一键配置本地 AI → 打开系统端

cd /d "%~dp0"

echo ==============================================
echo  热感哨兵 · 本地 AI 一键配置（Windows）
echo ==============================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] 这台电脑还没装 Node.js（运行网页端需要它；YOLO 那边是 Python，不受影响）。
  echo.
  echo     1 - 用 winget 自动安装（推荐，Windows 10/11 自带）
  echo     2 - 打开官网下载页手动安装
  echo     0 - 退出
  echo.
  set /p CHOICE=请输入数字后回车：
  if "%CHOICE%"=="1" (
    where winget >nul 2>nul
    if errorlevel 1 (
      echo [!] 这台电脑没有 winget，改用浏览器打开下载页…
      start https://nodejs.org/zh-cn
    ) else (
      echo · 正在用 winget 安装 Node.js LTS，装完请重开本窗口再双击一次…
      winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    )
  )
  if "%CHOICE%"=="2" start https://nodejs.org/zh-cn
  echo.
  echo 装好后请【关闭本窗口】重新双击一次本文件（PATH 需要新窗口才生效）。
  pause
  exit /b 1
)

for /f "delims=" %%i in ('node -v') do echo · Node 版本：%%i

rem 运行包自带 dist，正常情况下不需要装依赖 / 构建
if exist dist\index.html goto run

if not exist node_modules (
  echo · 没有预构建的站点，正在安装依赖（只做一次，需要联网）…
  call npm install
)

echo · 正在构建站点…
call npm run build

:run

echo.
node tools\setup-local-ai.mjs
set STATUS=%errorlevel%

echo.
if "%STATUS%"=="0" (
  echo [OK] 配置完成。上面打印的地址可以直接发给队友、或用手机扫码。
) else (
  echo [!] 有检查项没通过，请把上面的失败行连同"怎么修"一起发给项目负责人。
)
pause
