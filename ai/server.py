#!/usr/bin/env python3
"""FireAegis · 本地 AI 服务（YOLOv8 火焰/烟雾）

这份是**队友交付的 AI 模块**（原 `server.py`：摄像头循环 + YOLO 推理），
我这边只做了一件事：把它补齐成前端能直接接的接口，其它逻辑保持不动。

三个入口：
    GET  /health    → {"ok": true, "model": "yolov8n.pt", "camera": true}
    GET  /predict   → {"flame": 0-1, "smoke": 0-1}                 （队友原接口，保持不变）
    POST /detect    → body {"image": "data:image/jpeg;base64,...", "conf": 0.25}
                      返回 {"flame": 0-1, "smoke": 0-1, "detections": [...]}（前端视觉通道用这个）

为什么默认端口是 8000 而不是 5000：
    macOS 的 5000 被系统「隔空播放接收器」占用，而我们系统端的自动发现本来就在
    8000 / 8080 上找视觉服务。想改回去用 --port 5000 即可。

运行：
    pip install -r ai/requirements.txt
    python3 ai/server.py --model ai/yolov8n.pt --port 8000
"""

from __future__ import annotations

import argparse
import base64
import io
import threading
import time

# 类别名映射：两套都认 —— 队友训练时是 0=flame / 1=smoke，
# 公开预训练权重的名字则是 fire / smoke，两种都能落到同一个通道上。
FLAME_CLASS_IDS = {0}
SMOKE_CLASS_IDS = {1}
FIRE_LABELS = {"fire", "flame", "flames", "burning", "combustion", "火焰", "明火", "火"}
SMOKE_LABELS = {"smoke", "smog", "fume", "haze", "烟雾", "烟"}


def classify(label: str, class_id: int) -> str:
    """把检测框归到 flame / smoke / other。"""
    text = str(label or "").strip().lower()
    if text in FIRE_LABELS or (not text and class_id in FLAME_CLASS_IDS):
        return "flame"
    if text in SMOKE_LABELS or (not text and class_id in SMOKE_CLASS_IDS):
        return "smoke"
    if class_id in FLAME_CLASS_IDS and text not in SMOKE_LABELS:
        return "flame"
    if class_id in SMOKE_CLASS_IDS and text not in FIRE_LABELS:
        return "smoke"
    return "other"


def decode_image(data_url: str):
    """data:image/jpeg;base64,xxx 或裸 base64 → PIL 图片。"""
    from PIL import Image

    text = data_url or ""
    if "," in text and text.strip().startswith("data:"):
        text = text.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(text))).convert("RGB")


class DetectionState:
    """摄像头线程写、HTTP 线程读的最新置信度。"""

    def __init__(self) -> None:
        self.flame = 0.0
        self.smoke = 0.0
        self.updated_at = 0.0
        self.frames = 0
        self.error = ""

    def snapshot(self) -> dict:
        return {
            "flame": round(self.flame, 4),
            "smoke": round(self.smoke, 4),
            "frames": self.frames,
            "updated_at": self.updated_at,
            "camera_error": self.error,
        }


def summarize(results, model_name: str) -> dict:
    flame = 0.0
    smoke = 0.0
    detections = []
    for result in results:
        names = getattr(result, "names", {}) or {}
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            class_id = int(box.cls[0]) if box.cls is not None else -1
            label = str(names.get(class_id, class_id))
            confidence = float(box.conf[0]) if box.conf is not None else 0.0
            xyxy = [float(value) for value in box.xyxy[0]] if box.xyxy is not None else []
            kind = classify(label, class_id)
            detections.append({"label": label or kind, "kind": kind, "confidence": confidence, "box": xyxy})
            if kind == "flame":
                flame = max(flame, confidence)
            elif kind == "smoke":
                smoke = max(smoke, confidence)
    return {
        "ok": True,
        "model": model_name,
        "flame": round(flame, 4),
        "smoke": round(smoke, 4),
        "detections": detections,
    }


def camera_loop(model, state: DetectionState, source: int, interval: float, conf: float) -> None:
    """队友原来的摄像头主循环：不断推理最新一帧，把置信度写进全局状态。"""
    import cv2

    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        state.error = f"无法打开摄像头 source={source}"
        print(f">>> {state.error}（服务继续提供 /detect，可用 --no-camera 关掉这条循环）")
        return
    print(f">>> 摄像头已启动（source={source}），开始实时 YOLO 检测…")
    while True:
        ok, frame = capture.read()
        if not ok or frame is None:
            time.sleep(0.05)
            continue
        try:
            outcome = summarize(model(frame, conf=conf, verbose=False), getattr(model, "ckpt_path", "") or "")
            state.flame = outcome["flame"]
            state.smoke = outcome["smoke"]
            state.updated_at = time.time()
            state.frames += 1
            state.error = ""
        except Exception as error:  # 单帧失败不能把整个循环打死
            state.error = str(error)[:200]
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="FireAegis 本地 AI 服务（YOLOv8 火焰/烟雾）")
    parser.add_argument("--model", default="ai/yolov8n.pt", help="YOLO 权重路径（队友交付的是 yolov8n.pt）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址；局域网要 0.0.0.0，否则队友那台机器连不上")
    parser.add_argument("--port", type=int, default=8000, help="默认 8000（5000 被 macOS 隔空播放占用）")
    parser.add_argument("--conf", type=float, default=0.25, help="置信度阈值")
    parser.add_argument("--source", type=int, default=0, help="摄像头编号（0 为本机摄像头）")
    parser.add_argument("--fps", type=float, default=10.0, help="摄像头循环的目标帧率上限")
    parser.add_argument("--no-camera", action="store_true", help="只提供图片检测接口，不开摄像头循环")
    args = parser.parse_args()

    try:
        from flask import Flask, jsonify, request
        from flask_cors import CORS
        from ultralytics import YOLO
    except Exception as error:  # pragma: no cover
        raise SystemExit(
            "缺少依赖。请先在这台电脑上执行：\n"
            "    pip install -r ai/requirements.txt\n"
            f"原始报错：{error}"
        )

    model = YOLO(args.model)
    state = DetectionState()
    app = Flask(__name__)
    CORS(app)  # 浏览器直接调 /detect，必须允许跨源

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "model": args.model, "conf": args.conf, "camera": not args.no_camera, **state.snapshot()})

    @app.get("/predict")
    def predict():
        """队友原来的接口：前端每 3 秒抓一次当前置信度。"""
        payload = state.snapshot()
        return jsonify({"flame": payload["flame"], "smoke": payload["smoke"], "model": args.model, "camera": not args.no_camera})

    @app.post("/detect")
    def detect():
        """我们视觉通道的接口：前端把一张图 POST 过来，立刻返回结果。"""
        body = request.get_json(silent=True) or {}
        image_data = body.get("image")
        if not image_data:
            return jsonify({"ok": False, "error": "missing-image"}), 400
        try:
            image = decode_image(image_data)
        except Exception as error:
            return jsonify({"ok": False, "error": f"bad-image: {error}"}), 400
        conf = float(body.get("conf") or args.conf)
        try:
            outcome = summarize(model.predict(image, conf=conf, verbose=False), args.model)
        except Exception as error:
            return jsonify({"ok": False, "error": str(error)[:200]}), 500
        state.flame = outcome["flame"]
        state.smoke = outcome["smoke"]
        state.updated_at = time.time()
        return jsonify(outcome)

    if not args.no_camera:
        threading.Thread(
            target=camera_loop,
            args=(model, state, args.source, max(0.0, 1.0 / max(1.0, args.fps)), args.conf),
            daemon=True,
        ).start()

    print(f">>> FireAegis 本地 AI 服务已启动：http://0.0.0.0:{args.port}  模型={args.model}")
    print(f"    视觉通道地址填：http://<这台电脑的局域网IP>:{args.port}")
    print(f"    自检：curl http://127.0.0.1:{args.port}/health")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
