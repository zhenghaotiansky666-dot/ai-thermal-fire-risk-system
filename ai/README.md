# FireAegis · 本地 AI 模块（队友交付版）

这一份是**队友交付的 AI 模块原件 + 我们补齐的接口**。目录里的东西分两类：

| 文件 | 是什么 | 谁维护 |
| --- | --- | --- |
| `yolov8n.pt` | 训练/导出的 YOLO 权重 | AI 组 |
| `server.py` | 本地 AI 服务：摄像头循环 + YOLO 推理（原交付），我们补了 `/health`、`/detect` 两个前端要用的接口 | AI 组 / 软件组 |
| `train-and-export.py` | 用 `fire_dataset.csv` 训练并导出离线决策树（导出 C 代码） | AI 组 |
| `fire_dataset.csv` | 决策树数据集：`smoke, temp, rate, is_blocked → action` | AI 组 |
| `offline_copilot.c` / `.h` | 导出的离线决策树，给硬件/原生端直接用 | AI 组 |

> 网页端有同一套决策树的等价实现：`src/shared/offlineCopilot.js`（有单测），
> 判据与 C 版本逐行一致，保证"网页、原生、硬件"三个端给出的结论相同。

## 一、启动本地 AI 服务

```bash
pip3 install -r ai/requirements.txt          # 第一次，约几百 MB
python3 ai/server.py --model ai/yolov8n.pt --port 8000
```

也可以直接双击仓库根目录的 **`启动AI视觉.command`**（macOS）/ **`启动AI视觉.bat`**（Windows），
它会自己检查依赖、缺失时提示安装。

启动后：

```bash
curl http://127.0.0.1:8000/health
# {"ok":true,"model":"ai/yolov8n.pt","camera":true,...}
```

常用参数：`--port`（默认 8000，避开 macOS 被占用的 5000）、`--conf` 阈值、
`--source` 摄像头编号、`--no-camera` 只提供图片检测（没有摄像头的机器上用）。

## 二、接口

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 系统端自动发现用：返回模型名与摄像头状态 |
| `GET /predict` | **队友原接口**，返回摄像头最新一帧的 `{flame, smoke}` |
| `POST /detect` | 前端视觉通道：body `{image: "data:image/jpeg;base64,…", conf}`，返回 `{flame, smoke, detections}` |

## 三、系统端怎么接上（不用改代码）

1. 先启动本服务（8000）；
2. 打开系统端——`public/ai-config.json` 里视觉通道已默认填 `http://127.0.0.1:8000`，
   `aiDiscovery` 也会自动探测 8000/8080；
3. 「监控」页硬件卡片下方能看到 AI 网关，「检测」页阶段一会显示
   `视觉通道已接入：火焰 xx% · 烟雾 xx%`，并出现「离线 AI 决策树」的通行/封路结论。

如果 AI 服务跑在另一台电脑上，把 `public/ai-config.json` 的 `visionUrl` 改成
`http://<那台电脑的局域网IP>:8000` 即可（记得用 `--host 0.0.0.0` 启动）。

## 四、离线决策树

`train-and-export.py` 依据 `fire_dataset.csv` 导出 `offline_copilot.c`，规则是：

```c
input = [smoke, temp, rate, is_blocked]   // 0.0 = PASS 通行，1.0 = BLOCK 封路
if (is_blocked > 0.5) return 1.0;         // 视觉通道受阻
if (temp > 60.0 || smoke > 80.0) return 1.0;
return 0.0;
```

网页端用 `src/shared/offlineCopilot.js` 复现同一套判据：
温度超 60°C 或烟雾越线时，用户端会把这条出口标为受阻并**自动改走另一条**，
系统端阶段一也会并列显示这个结论。
