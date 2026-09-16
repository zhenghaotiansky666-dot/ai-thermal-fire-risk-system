"""热感哨兵 · YOLO 视觉服务（火焰/烟雾检测）

为什么要有这一层：我们的前端不会直接跑 YOLO（浏览器里跑不动、也没必要），
而是让 YOLO 在一台机器上以 HTTP 服务方式跑，前端把图片 POST 过来、拿回置信度。

接口（与 src/shared/visionClient.js 约定一致）：
    GET  /health   → {"ok": true, "model": "yolov8n.pt"}
    POST /detect   → body {"image": "data:image/jpeg;base64,...", "conf": 0.25}
                     返回 {"flame": 0-1, "smoke": 0-1, "detections": [{"label": "fire", "confidence": 0.87, "box": [x1,y1,x2,y2]}]}

运行（在跑 YOLO 的那台电脑上）：
    pip install -r requirements.txt
    python app.py --model yolov8n.pt --host 0.0.0.0 --port 8000

要点：
  · 一定要用 --host 0.0.0.0 启动，否则队友那台电脑连不上（和 Ollama 是同一个坑）；
  · 已开启 CORS（允许浏览器直接调用）；
  · 如果用的是自己训练的权重，把 --model 换成 .pt 文件路径即可；
  · 类别名默认按 COCO（fire/smoke 不一定在 COCO 里）——请改成你们训练时的类别名（见 FIRE_LABELS）。
"""

import argparse
import base64
import io
import re

from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image

FIRE_LABELS = {"fire", "flame", "flames", "burning", "combustion", "火焰", "明火"}
SMOKE_LABELS = {"smoke", "smog", "fume", "haze", "烟雾", "烟"}


def decode_image(data_url: str) -> Image.Image:
    """把 data:image/jpeg;base64,xxx 或裸 base64 解成 PIL 图片。"""
    match = re.match(r"^data:image/\w+;base64,(.*)$", data_url or "", flags=re.S)
    payload = match.group(1) if match else (data_url or "")
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="yolov8n.pt", help="Ultralytics 权重文件（.pt）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，局域网要 0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()

    # 延迟导入：没装 ultralytics 时也能把服务起起来看到明确报错
    try:
        from ultralytics import YOLO
    except Exception as error:  # pragma: no cover
        raise SystemExit(
            "没有找到 ultralytics。请先执行：\n"
            "    pip install -r requirements.txt\n"
            f"原始报错：{error}"
        )

    model = YOLO(args.model)
    app = Flask(__name__)
    CORS(app)  # 允许浏览器跨源调用（否则前端会被 CORS 拦掉）

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "model": args.model, "conf": args.conf})

    @app.post("/detect")
    def detect():
        body = request.get_json(silent=True) or {}
        image_data = body.get("image")
        if not image_data:
            return jsonify({"ok": False, "error": "missing-image"}), 400
        conf = float(body.get("conf") or args.conf)
        try:
            image = decode_image(image_data)
        except Exception as error:
            return jsonify({"ok": False, "error": f"bad-image: {error}"}), 400

        results = model.predict(image, conf=conf, verbose=False)
        detections = []
        flame = 0.0
        smoke = 0.0
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
                detections.append({"label": label, "confidence": confidence, "box": xyxy})
                lowered = label.strip().lower()
                if lowered in FIRE_LABELS:
                    flame = max(flame, confidence)
                if lowered in SMOKE_LABELS:
                    smoke = max(smoke, confidence)

        return jsonify({
            "ok": True,
            "model": args.model,
            "flame": round(flame, 4),
            "smoke": round(smoke, 4),
            "detections": detections,
        })

    print(f"YOLO 视觉服务已启动：http://0.0.0.0:{args.port}  模型={args.model}")
    print("在系统端「AI 指挥 → 视觉通道（YOLO）」里填这台机器的地址，例如 http://192.168.1.20:8000")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
