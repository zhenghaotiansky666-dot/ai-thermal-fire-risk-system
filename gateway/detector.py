#!/usr/bin/env python3
"""Optional camera detector for the laptop AI gateway.

Supports:
- YOLO model inference through ultralytics if --model is provided.
- OpenCV red/bright-region heuristic when no model is available.
- JSON-lines simulation fallback when OpenCV or the camera source is unavailable.
"""
from __future__ import annotations
import argparse
import json
import math
import time


def simulate(index: int, camera_id: str) -> dict:
    hot = index % 20 in range(8, 17)
    return {
        'camera_id': camera_id,
        'source': 'laptop-detector-simulator',
        'risk': 'high' if hot else 'low',
        'max_temp': 78 + (index % 12) if hot else 31 + (index % 5),
        'detections': [
            {'class': 'flame', 'confidence': 0.86, 'bbox': [0.55, 0.34, 0.14, 0.18]},
            {'class': 'smoke', 'confidence': 0.79, 'bbox': [0.22, 0.23, 0.2, 0.2]},
        ] if hot else [],
        'hotspots': [{'x': 0.56, 'y': 0.35, 'width': 0.14, 'height': 0.18, 'temp': 80.2, 'confidence': 0.91}] if hot else [],
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--camera-id', default='laptop-ai-camera')
    parser.add_argument('--model', default='')
    parser.add_argument('--fps', type=float, default=3)
    args = parser.parse_args()

    try:
        import cv2
    except Exception:
        print('OpenCV unavailable; using simulation output.', flush=True)
        index = 0
        while True:
            print(json.dumps(simulate(index, args.camera_id), ensure_ascii=False), flush=True)
            index += 1
            time.sleep(1 / max(args.fps, 1))
        return

    capture = cv2.VideoCapture(args.source)
    if not capture.isOpened():
        raise SystemExit(f'Cannot open source: {args.source}')

    model = None
    if args.model:
        try:
            from ultralytics import YOLO
            model = YOLO(args.model)
        except Exception as error:
            print(f'YOLO unavailable ({error}); using heuristic detector.', flush=True)

    index = 0
    interval = 1 / max(args.fps, 1)
    while True:
        ok, frame = capture.read()
        if not ok:
            time.sleep(interval)
            continue
        height, width = frame.shape[:2]
        detections = []
        hotspots = []
        if model is not None:
            result = model.predict(frame, verbose=False, conf=0.35)[0]
            names = result.names
            for box in result.boxes:
                x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
                label = str(names[int(box.cls[0])])
                detections.append({
                    'class': label,
                    'confidence': round(float(box.conf[0]), 3),
                    'bbox': [x1 / width, y1 / height, (x2 - x1) / width, (y2 - y1) / height],
                })
        else:
            small = cv2.resize(frame, (160, 90))
            hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
            mask = cv2.inRange(hsv, (0, 100, 150), (20, 255, 255))
            moments = cv2.moments(mask)
            area = moments['m00']
            if area > 80:
                cx = moments['m10'] / area / 160
                cy = moments['m01'] / area / 90
                size = min(0.3, max(0.08, math.sqrt(area) / 160))
                detections.append({'class': 'flame_or_hot_object', 'confidence': 0.61, 'bbox': [max(0, cx - size / 2), max(0, cy - size / 2), size, size]})
                hotspots.append({'x': cx, 'y': cy, 'width': size, 'height': size, 'temp': 65.0, 'confidence': 0.61})
        payload = {
            'camera_id': args.camera_id,
            'source': 'laptop-detector-opencv' if model is None else 'laptop-detector-yolo',
            'risk': 'high' if any(item['class'] in ('flame', 'fire', 'smoke') for item in detections) else 'medium' if detections else 'low',
            'max_temp': 78.0 if hotspots else 31.0,
            'detections': detections,
            'hotspots': hotspots,
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        }
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        index += 1
        time.sleep(interval)


if __name__ == '__main__':
    main()
