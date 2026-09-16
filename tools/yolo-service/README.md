# YOLO 视觉服务（火焰 / 烟雾）

## 一条命令跑起来

```bash
cd tools/yolo-service
pip install -r requirements.txt
python app.py --model yolov8n.pt --host 0.0.0.0 --port 8000
```

自测：

```bash
curl http://127.0.0.1:8000/health
```

## 接到我们的系统里

系统端（或用户端）→「AI 指挥」面板 → **视觉通道（YOLO）**：

- 服务地址：`http://<跑YOLO那台电脑的IP>:8000`
- 权重/模型名：`yolov8n.pt`（自己训练的权重填文件名即可）
- 置信度阈值：默认 0.25
- 点「测试视觉通道」应显示可用；之后阶段一的「火焰 / 烟雾」会直接来自 YOLO，
  三路证据融合（热像 + 火焰 + 烟雾）自动生效。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 队友那台电脑连不上 | 服务只监听 127.0.0.1 | 必须 `--host 0.0.0.0` |
| 浏览器报 CORS | 没开跨源 | 本模板已 `CORS(app)`；自建服务记得加 `Access-Control-Allow-Origin: *` |
| 检测不到火/烟 | 权重是 COCO 通用模型，没有 fire/smoke 类 | 用自己训练的权重；或把类别名加进 `app.py` 的 `FIRE_LABELS` |
| 404 | 路径写成 `/detect` 之外 | 前端固定调用 `/health` 与 `/detect` |

## 和 Ollama 的关系

两者是**两条独立通道**，可以同时用：

| 通道 | 负责 | 端点示例 | 界面位置 |
| --- | --- | --- | --- |
| 对话模型（Ollama / LM Studio / 自建） | 指挥决策、救援简报、路线图读图 | `/ai/v1` | 「AI 指挥」 |
| 视觉检测（YOLO） | 火焰 / 烟雾置信度（阶段一） | `http://IP:8000` | 「视觉通道（YOLO）」 |
