# FireAegis · AI 热感火警预警与动态疏散系统

基于热成像与计算机视觉的早期火灾预警科研演示原型。

## 在线访问

网站通过 GitHub Pages 自动发布：

https://zhenghaotiansky666-dot.github.io/ai-thermal-fire-risk-system/

## AI 接入（本地 AI 模块）

队友交付的 AI 模块在 **`ai/`**：YOLOv8 火焰/烟雾权重 + 一个离线决策树（导出成 C 代码）。
我们补齐了前端要用的接口，并做了两个端的接线：

```bash
pip3 install -r ai/requirements.txt
python3 ai/server.py --model ai/yolov8n.pt --port 8000
# 也可以直接双击 启动AI视觉.command（macOS）/ 启动AI视觉.bat（Windows）
```

- **视觉通道**：系统端「检测」页阶段一显示 `视觉通道已接入：火焰 xx% · 烟雾 xx%`，
  `public/ai-config.json` 已默认指向 `http://127.0.0.1:8000`，打开系统端会自动探测并接上；
- **离线决策树**：`src/shared/offlineCopilot.js` 与 `ai/offline_copilot.c` 判据逐行一致
  （温度 > 60°C 或烟雾越线 → 封路），用户端据此自动改走另一条出口，系统端阶段一并列显示结论。

**ai/README.md** —— 接口说明（`/health`、`/predict`、`/detect`）、权重替换、决策树规则。

## 电脑版指挥端（大屏监看）

同一套系统，宽的屏幕会自动切成**电脑布局**：左侧竖向导航 + 自适应多列卡片墙。

- **直接用**：用电脑打开系统端即可，宽度 ≥1180px 自动进入电脑布局；
- **监看模式**：右上角点「电脑监看」，或访问 `mobile-app.html?monitor=1`
  ——左栏收起、内容铺满并全屏，适合挂在大屏上当值守终端（设置会记住）；
- **装到电脑上**：双击 `启动电脑版.command`（macOS）/ `启动电脑版.bat`（Windows），
  脚本会自动检查 Node、构建（如需）、启动站点与硬件接收端，并用独立窗口打开；
- **下载与说明页**：站点里的 `desktop-install.html`（指挥端右上角「电脑版」按钮）。

打包成压缩包分发：

```bash
node tools/make-desktop-zip.mjs outputs     # 产出 FireAegis-电脑版-<日期>.zip
```

## 给队友的编辑指南

仓库是公开的，硬件同学可以直接 clone/fork，按这份指南改硬件参数：

**docs/硬件同学-编辑指南.md** —— 端口三处怎么改、`/upload` 与 `/upload_thermal` 的约定、
终审阈值、固件两行地址怎么生成、哪些接口不要动、以及自检与常见坑。

## AI 网关接入（YOLOv8 视觉通道）

笔记本接摄像头跑 YOLOv8（或 OpenCV 兜底、或模拟器），通过 WebSocket 持续推送检测结果：

```bash
node gateway/ai-gateway.mjs --mode simulator --port 8899
node gateway/ai-gateway.mjs --mode detector --source 0 --model best.pt --port 8899
```

系统端「监控」页的 **AI 网关**卡片填 `ws://127.0.0.1:8899/ws/detections` 即可连接。
火焰/烟雾置信度会直接进入阶段一的三路证据融合与报警判定（不是只显示目标数），
超过 8 秒没有新帧就按"无证据"处理。

**docs/AI网关接入说明.md** —— 端口分工（8787 硬件 / 8899 AI）、消息格式、
HTTPS 页面下的 wss 与同源代理、联调检查清单。

## 网线接入（W5500 以太网）

硬件侧支持 Wi-Fi 与 SPI 网卡（W5500）双介质。接收端会优先挑选有线网卡并打印对应固件地址：

```bash
node tools/hardware-receiver.mjs --print-firmware --medium ethernet   # 只取有线网卡
node tools/hardware-receiver.mjs --print-firmware --interface en5     # 指定网卡
```

每帧数据都会记录来源 IP，指挥端可据此判断这一路走的是网线还是 Wi-Fi。

**docs/网线接入（W5500）-远程接口.md** —— 电脑端确认网卡、W5500 SPI 接线片段、
跨网段同源代理、验证步骤与改动清单。

## 软件方向介绍（PPT 素材）

**docs/软件方向介绍（PPT素材）.md** —— 系统端六大模块、三阶段 AI 决策链、
用户端三步使用流程与便捷性设计，附建议截图清单。

## 用户端联动（隐患照片 / 求助上报 → 系统端）

用户端「更多 → 隐患上报」拍照 + 描述提交后，系统端「看板 → 用户端联动」会收到
照片、位置与时间；用户端自救问答的求助结果同样汇总过去。两条链路自动选：

- **同一设备**：两端共用 `thermalGuardHazards` / `thermalGuardUserStatus`，跨标签页即时可见；
- **跨设备**：走本仓库已有的三级事件总线（局域网中继 → ntfy/自建中继 → 离线码），
  用户端扫码加入演练后手机上拍的照片会同步到系统端；
- 走公网 ntfy 时照片先当附件上传、事件里只带链接（消息体只有 4KB，塞不下图）。

逻辑在 `src/shared/userReports.js`（纯函数，有单测 `tests/userReports.test.mjs`），
面板在 `src/mobile/LinkedReportsPanel.jsx`。

## 大模型免 Key 代理（可选）

`gateway/llm-proxy/` 是一个 Cloudflare Worker：把大模型 API Key 放在服务端，
线上静态站点只填代理地址，用户看不到 Key。接口与 OpenAI `/chat/completions` 同构，
直接把 AI 指挥的端点地址填成 Worker 地址即可，不用改前端代码。

**gateway/llm-proxy/README.md** —— 部署命令、`LLM_API_KEY` / `PROXY_TOKEN` 配置、切换服务商。

## 功能

- 热成像图片上传、拖拽与本地预览
- 模拟 AI 检测加载与进度反馈
- 低、中、高风险三级预警
- 高温疑似区域框选与温度估算
- 检测数据统计、趋势图与风险分布
- 桌面端与移动端响应式适配

## 移动端火警报警与逃生指引

移动端 GPS 之外的另一条主线：**检测到高风险 → 全屏报警 → 动态逃生路线**。

### 报警中心

- 图片检测判定为高风险时自动触发全屏警报；中风险只出提示，不打断现场
- 全屏高对比警报：闪屏、图标脉冲、已持续计时；静音/勿扰下仍有画面提示
- Web Audio 双音慢速扫频警笛 + 中文语音循环播报 + 震动（iOS Safari 不支持震动）
- 已知晓静音 / 重新鸣响 / 解除警报；风险未回落时不重新布防，避免反复自动报警
- 未确认升级：默认 30 秒后提高音量并加快播报，可配置或关闭
- 火警演练：指定楼层与起火点，全程标注「演练」
- 可调阈值（高温 / 中风险）与报警记录留痕，均持久化在本机

### 逃生指引

- 楼宇拓扑：8 层示意楼宇，A/B 双楼梯贯通，1 楼大堂正门 + 8 楼天台两个出口
- 危险扩散模型：以火源为中心的图跳数扩散，烟气上行快于下行，半径随起火时间增长
- A\* 动态避障：浓烟重罚、烟气边缘轻罚、起火点不可通行，路线每秒重算
- SVG 平面图：路线虚线 + 方向箭头 + 火源脉冲 + 危险区着色 + 当前位置 + 受阻标记
- 分步文字指引（含距离与预计时间）、大字跟随模式、8 层剖面
- 封锁 A 梯 / B 梯 / 正门 / 天台后自动改道；优先向下撤离，天台仅作向下通道中断时的备选

## 测试

路线规划与热像仪数据源的纯逻辑测试（无需浏览器）：

```bash
pnpm test
```

## macOS 原生 App

安装包下载：[最新 GitHub Release](https://github.com/roubizhao6-sys/ai-thermal-fire-risk-system/releases/latest)

- `AIThermalFireGuard-macOS-1.0.3.dmg`：推荐分享给其他 Mac 用户
- `AIThermalFireGuard-macOS-1.0.3.zip`：ZIP 版本
- 支持 Intel 与 Apple Silicon
- DMG 内包含 ESP32 示例固件和安装说明


原生 SwiftUI 应用位于 `macos/AIThermalFireGuard`，支持：

- 内置模拟热像仪
- ESP32 USB 串口接入
- Wi-Fi WebSocket 接入
- 32×24 热成像矩阵与风险分级
- SceneKit 3D 热源重建与实时监控
- 指南针方向提示与推荐疏散路线
- 实验设备采购、接线与固件示例

运行：

```bash
cd macos/AIThermalFireGuard
./script/build_and_run.sh
```

## 本地运行

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
```

> 本系统为科研演示原型，不替代专业消防检测设备。
