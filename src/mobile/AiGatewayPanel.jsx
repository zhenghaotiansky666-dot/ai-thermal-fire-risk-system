// 系统端「AI 网关 · 视频流视觉通道」
//
// 队友交付的 AI 是"笔记本端网关"：接摄像头 → YOLOv8（或 OpenCV 兜底 / 模拟器）
// → 通过 WebSocket 持续推送火焰与烟雾的置信度。
//
// 这一步把那条流接进我们的决策链：连接成功后会把 flame / smoke 注册进「视觉通道」，
// 于是阶段一的三路证据融合（视觉 + 烟感 + 热像）与报警判定会自动使用它的结果。

import { useEffect, useState } from 'react'
import { Cpu, PlugZap, RefreshCw, Unplug, Waves } from 'lucide-react'
import {
  DEFAULT_GATEWAY_URL,
  connectGateway,
  disconnectGateway,
  gatewayStatus,
  readGatewayUrl,
  subscribeGateway,
} from '../shared/aiGateway.js'

function percent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
}

const RISK_LABEL = { low: '正常', medium: '观察', high: '告警' }

export default function AiGatewayPanel({ onToast }) {
  const [draft, setDraft] = useState(() => readGatewayUrl())
  const [status, setStatus] = useState(() => gatewayStatus())

  useEffect(() => subscribeGateway(setStatus), [])

  const connected = status.status === 'connected'
  const normalized = status.normalized
  const targets = (normalized?.detections ?? []).filter((item) => !/person|人/i.test(item.label))

  return (
    <section className="mobile-card ai-gateway-card">
      <div className="card-head">
        <div>
          <strong>AI 网关 · 视频流视觉通道</strong>
          <small>笔记本摄像头 → YOLOv8 → WebSocket 推送（火焰 / 烟雾置信度）</small>
        </div>
        <Waves size={18} />
      </div>

      <div className={`ai-gateway-status state-${status.status}`}>
        <i />
        <span>
          {status.status === 'connected'
            ? `网关在线 · 已收到 ${status.received} 帧`
            : status.status === 'connecting'
              ? '正在连接网关…'
              : status.status === 'failed'
                ? '连接失败'
                : '网关未连接'}
        </span>
        {connected && <b>{targets.length} 个目标</b>}
      </div>

      <label className="ai-gateway-input">
        <span>WebSocket 地址</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={DEFAULT_GATEWAY_URL}
          inputMode="url"
          autoCapitalize="none"
        />
      </label>

      <div className="ai-gateway-actions">
        <button type="button" className="primary" onClick={() => { connectGateway(draft); onToast?.('正在连接 AI 网关…') }}>
          <PlugZap size={14} />连接
        </button>
        <button type="button" onClick={() => { disconnectGateway(); onToast?.('已断开 AI 网关') }}>
          <Unplug size={14} />断开
        </button>
        <button type="button" onClick={() => connectGateway(draft)} disabled={!connected}>
          <RefreshCw size={14} />重连
        </button>
      </div>

      {connected && (
        <div className="ai-gateway-readout">
          <div><span><Cpu size={12} />火焰</span><strong className={normalized?.flame >= 0.5 ? 'is-hot' : ''}>{percent(normalized?.flame)}</strong></div>
          <div><span><Cpu size={12} />烟雾</span><strong className={normalized?.smoke >= 0.45 ? 'is-hot' : ''}>{percent(normalized?.smoke)}</strong></div>
          <div><span>网关分级</span><strong>{RISK_LABEL[normalized?.risk] ?? '—'}</strong></div>
          <div><span>最高温</span><strong>{normalized?.maxTemp ? `${normalized.maxTemp.toFixed(1)}°C` : '—'}</strong></div>
        </div>
      )}

      {status.error && <p className="ai-gateway-error">{status.error}</p>}

      <p className="situation-note">
        连接后，这条流里的<b>火焰 / 烟雾置信度会直接进入三路证据融合</b>与报警判定，
        不再只是显示目标数。跑网关：
        <code> node gateway/ai-gateway.mjs --mode detector --source 0 --model best.pt --port 8899</code>
        （没有摄像头/模型时会自动用模拟器输出）。
      </p>
      <p className="situation-note">
        端口说明：<code>8787</code> 留给硬件接收端（ESP32-S3），所以网关建议跑在 <code>8899</code>；
        HTTPS 站点需要 <code>wss://</code>，本地演示打开网关自己提供的 http 地址即可。
      </p>
    </section>
  )
}
