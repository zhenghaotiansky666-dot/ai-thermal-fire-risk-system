#!/bin/bash
# 双击即可（macOS）：一键装好并启动 FireAegis 的本地 AI
#   · 视觉模型：ai/best.pt（队友训练的 YOLOv8 火焰/烟雾）→ 端口 8000
#   · 决策模型：ai/ 里的 Modelfile + models/*.gguf → Ollama → 端口 11434
# 如果双击没反应，先在"终端"里执行：chmod +x 启动AI.command

set -u
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
AI_DIR="$ROOT/ai"
MODEL_DIR="$ROOT/models"
GGUF="$MODEL_DIR/qwen2.5-3b-instruct.gguf"
OLLAMA_ZIP="$ROOT/Ollama-运行时.zip"
MODEL_URL="${FIREAEGIS_MODEL_URL:-}"
OLLAMA_BIN=""

echo "=============================================="
echo " FireAegis · 本地 AI 一键启动"
echo "=============================================="
echo ""

# ---------- 0. 找 Python（视觉模型要用） ----------
PY=""
for candidate in "$AI_DIR/.venv/bin/python" "$(command -v python3)" "$(command -v python)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && PY="$candidate" && break
done

# ---------- 1. 找 / 装 Ollama ----------
for candidate in \
  "$HOME/Applications/Ollama.app/Contents/Resources/ollama" \
  "/Applications/Ollama.app/Contents/Resources/ollama" \
  "$(command -v ollama 2>/dev/null)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && OLLAMA_BIN="$candidate" && break
done

if [ -z "$OLLAMA_BIN" ]; then
  echo "· 没找到 Ollama，正在安装（只做一次）…"
  if [ -f "$OLLAMA_ZIP" ]; then
    echo "  使用包内的离线安装包：$OLLAMA_ZIP"
    unzip -q -o "$OLLAMA_ZIP" -d "/tmp/fireaegis-ollama" >/dev/null 2>&1
  else
    echo "  从官网下载 Ollama（约 200MB，需要联网）…"
    mkdir -p /tmp/fireaegis-ollama
    curl -L --progress-bar -o /tmp/fireaegis-ollama/Ollama-darwin.zip \
      "https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip" || true
    unzip -q -o /tmp/fireaegis-ollama/Ollama-darwin.zip -d /tmp/fireaegis-ollama >/dev/null 2>&1
  fi
  if [ -d "/tmp/fireaegis-ollama/Ollama.app" ]; then
    mkdir -p "$HOME/Applications"
    cp -R "/tmp/fireaegis-ollama/Ollama.app" "$HOME/Applications/" 2>/dev/null
    OLLAMA_BIN="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
  fi
fi

if [ -n "$OLLAMA_BIN" ] && [ -x "$OLLAMA_BIN" ]; then
  echo "· Ollama：$OLLAMA_BIN"
  # 已经在跑就不重复起
  if ! curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "  启动 ollama serve（后台）…"
    nohup "$OLLAMA_BIN" serve > "$ROOT/ollama.log" 2>&1 &
    for _ in $(seq 1 20); do
      curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "  Ollama 已就绪：http://127.0.0.1:11434"
    # ---------- 2. 装决策模型（没有就导入） ----------
    if "$OLLAMA_BIN" list 2>/dev/null | grep -q "fireaegis"; then
      echo "· 决策模型 fireaegis 已在（跳过导入）"
    elif [ -f "$GGUF" ]; then
      echo "· 正在导入决策模型 fireaegis（1.9GB，第一次约 1 分钟）…"
      "$OLLAMA_BIN" create fireaegis -f "$AI_DIR/Modelfile.fireaegis"
    elif [ -n "$MODEL_URL" ]; then
      echo "· 本地没有模型文件，从 $MODEL_URL 下载…"
      mkdir -p "$MODEL_DIR"
      curl -L --progress-bar -o "$GGUF" "$MODEL_URL" || true
      [ -f "$GGUF" ] && "$OLLAMA_BIN" create fireaegis -f "$AI_DIR/Modelfile.fireaegis"
    else
      echo "⚠️ 没找到 models/qwen2.5-3b-instruct.gguf，也没设 FIREAEGIS_MODEL_URL。"
      echo "   把模型文件放进 models/ 后重新双击本文件即可（视觉 AI 不受影响，继续启动）。"
    fi
  else
    echo "⚠️ Ollama 没起来，决策模型暂时不可用（页面会自动回落到本机规则引擎）。"
  fi
else
  echo "⚠️ Ollama 安装失败或没联网。决策模型暂时不可用（视觉 AI 不受影响）。"
fi
echo ""

# ---------- 3. 视觉模型（YOLO） ----------
if [ -z "$PY" ]; then
  echo "⚠️ 这台电脑没有 python3，视觉模型无法启动。"
  echo "   装好 Python 3 后重新双击本文件即可：https://www.python.org/downloads/"
else
  if ! "$PY" -c "import ultralytics, flask, flask_cors" >/dev/null 2>&1; then
    echo "· 首次运行需要装视觉依赖（约几百 MB，需要联网）…"
    "$PY" -m pip install -q -r "$AI_DIR/requirements.txt" 2>/dev/null || \
      "$PY" -m pip install -q --user -r "$AI_DIR/requirements.txt" 2>/dev/null || true
  fi
  if "$PY" -c "import ultralytics, flask, flask_cors" >/dev/null 2>&1; then
    if curl -s -m 2 http://127.0.0.1:8000/health >/dev/null 2>&1; then
      echo "· 视觉服务已经在跑（8000）"
    else
      echo "· 启动视觉服务（YOLO + ai/best.pt，端口 8000）…"
      nohup "$PY" "$AI_DIR/server.py" --model "$AI_DIR/best.pt" --port 8000 --no-camera \
        > "$ROOT/视觉服务.log" 2>&1 &
      for _ in $(seq 1 30); do
        curl -s -m 2 http://127.0.0.1:8000/health >/dev/null 2>&1 && break
        sleep 1
      done
    fi
    curl -s -m 3 http://127.0.0.1:8000/health >/dev/null 2>&1 \
      && echo "  视觉服务已就绪：http://127.0.0.1:8000（权重 ai/best.pt）" \
      || echo "⚠️ 视觉服务没起来，日志见：$ROOT/视觉服务.log"
  else
    echo "⚠️ 视觉依赖安装失败（可能没联网）。日志：$ROOT/视觉服务.log"
  fi
fi

echo ""
echo "=============================================="
echo " AI 启动完成，现在可以双击「启动电脑版」打开系统端"
echo " 系统端会自己识别到：fireaegis:latest（决策）+ YOLO（视觉）"
echo "=============================================="
echo ""
echo "按回车键关闭这个窗口（AI 会继续在后台运行）。"
read -r _
