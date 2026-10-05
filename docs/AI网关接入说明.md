# AI 网关接入说明（YOLOv8 视觉通道）

面向队友交付的 **本地 AI 模块**：`gateway/ai-gateway.mjs` + `gateway/detector.py`。
笔记本接摄像头跑 YOLOv8（或 OpenCV 兜底、或模拟器），把检测结果通过 WebSocket
持续推给系统端；系统端把它当作一条**视觉证据通道**接入既有的预警决策链。

---

## 一、端口分工（两个服务可以同时跑）

| 端口 | 服务 | 用途 |
| --- | --- | --- |
| **8787** | `tools/hardware-receiver.mjs` | ESP32-S3 上传可见光 `/upload` 与红外热像 `/upload_thermal` |
| **8899** | `gateway/ai-gateway.mjs` | 笔记本摄像头 → YOLOv8 → WebSocket `/ws/detections` |

两个端口分开是为了：演示时硬件走网线/热点进 8787，笔记本 AI 走 8899，
互不抢占，同一台电脑就能同时开。

---

## 二、跑起来（三种模式）

```bash
# 1) 纯模拟（没有摄像头、没有模型时的联调/演示，每 500ms 推一帧）
node gateway/ai-gateway.mjs --mode simulator --port 8899

# 2) 真摄像头 + 训练好的权重（best.pt）
node gateway/ai-gateway.mjs --mode detector --source 0 --model best.pt --fps 3 --port 8899

# 3) 视频文件/RTSP 流回放（把火灾演示视频喂进去）
node gateway/ai-gateway.mjs --mode detector --source ./demo/fire.mp4 --model best.pt --port 8899
```

> `--source 0` 是本机摄像头编号；没有 `--model` 时 `detector.py` 会自动退回 OpenCV
> 的红色/高亮区域启发式，仍然能产出 `flame` / `smoke` 结构，方便先打通链路。

启动后终端会打印本机可用地址，例如：

```
AI gateway running (http/ws)
Local app:  http://127.0.0.1:8899/mobile-app.html
LAN app:    http://192.168.x.x:8899/mobile-app.html
WebSocket:  ws://192.168.x.x:8899/ws/detections
Health:     http://127.0.0.1:8899/health
```

**推荐做法**：演示时直接打开网关自带的 `http://<笔记本IP>:8899/mobile-app.html`。
这是 http 页面，可以直接连 `ws://`，不会遇到下面第四节说的混合内容问题。

---

## 三、WebSocket 消息约定

系统端订阅：`ws://<主机>:8899/ws/detections`

```json
{
  "camera_id": "laptop-ai-camera",
  "source": "yolov8",
  "risk": "low | medium | high",
  "max_temp": 85.5,
  "detections": [
    { "class": "flame", "confidence": 0.87, "bbox": [0.55, 0.34, 0.14, 0.18] },
    { "class": "smoke", "confidence": 0.92, "bbox": [0.22, 0.23, 0.2, 0.2] }
  ],
  "hotspots": [{ "x": 0.56, "y": 0.35, "width": 0.14, "height": 0.18, "temp": 80.2, "confidence": 0.91 }],
  "timestamp": "2026-10-05T19:42:10+0800"
}
```

- `class` 只认 `flame` / `smoke`（也兼容 `fire` / 中文标签），其余标签会被忽略；
- 同一帧里同类目标取**最大置信度**；
- 消息超过 **8 秒**没更新，系统端视为"无证据"，不会拿旧帧继续报警；
- 连接断开/重连由系统端负责，网关只管持续推。

---

## 四、系统端这一侧做了什么（比队友交付多的一步）

队友原来的实现是把这条流**显示**出来（目标数量）。我们在 `src/shared/aiGateway.js`
里多做了一步：把 `flame` / `smoke` 置信度**注册进视觉通道**
（`registerVisionDetector`），于是它会真正进入：

1. 阶段一「三路证据融合」——视觉 + 热像 + 烟感共同投票；
2. 报警判定——输出判据得分、置信度、有效证据路数；
3. 周边居民通知文案生成。

也就是说，AI 网关不是一块"监控画面"，而是**能改变报警结论的一路传感器**。

具体位置：

- `src/shared/aiGateway.js`：WebSocket 客户端 + 消息归一化 + 视觉通道注册 + 时效控制；
- `src/mobile/AiGatewayPanel.jsx`：系统端「监控」页的 AI 网关卡片
  （填地址、连接/断开、状态帧数、火焰/烟雾/分级/最高温读数）；
- 系统端启动时若本机保存过网关地址，会自动重连；否则保持空闲，不偷偷占端口。

---

## 五、页面是 HTTPS 时的注意事项

GitHub Pages 上的系统端是 `https://`，浏览器会拦截页面里发起的 `ws://`（混合内容）。
三种解法，按推荐顺序：

1. **用网关自带的站点**：`http://<笔记本IP>:8899/mobile-app.html`（最省事，演示首选）；
2. 网关加 TLS：给 `ai-gateway.mjs` 传 `--tls-cert` / `--tls-key`，页面侧填 `wss://...`；
3. 站点侧做同源反代（`/ai-ws` → `ws://127.0.0.1:8899/ws/detections`），需要能改部署环境时再用。

---

## 六、联调检查清单

1. `curl http://127.0.0.1:8899/health` 有响应；
2. 系统端「监控」页 → AI 网关卡片 → 填 `ws://127.0.0.1:8899/ws/detections` → 连接；
3. 卡片出现「网关在线 · 已收到 N 帧」，并有火焰/烟雾读数；
4. 「检测」页阶段一面板出现 `AI 网关视频流：火焰 xx% · 烟雾 xx%`，有效证据路数 ≥ 2；
5. 关掉网关，8 秒后读数应自动归零/失效，报警结论回落。

> 常见坑：端口写成 8787（那是硬件接收端）；页面是 https 却填 `ws://`（见第五节）；
> 权重路径写成相对路径但工作目录不对（用绝对路径最稳）。
