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
  echo [X] 这台电脑还没装 Node.js（运行本项目需要它）。
  echo     请打开 https://nodejs.org/zh-cn 下载 Windows 版（选 LTS），装完再双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%i in ('node -v') do echo · Node 版本：%%i

if not exist node_modules (
  echo · 首次运行，正在安装依赖（只做一次，需要联网）…
  call npm install
)

if not exist dist (
  echo · 正在构建站点…
  call npm run build
)

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
