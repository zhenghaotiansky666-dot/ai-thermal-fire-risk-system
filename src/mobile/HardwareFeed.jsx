// 系统端「硬件直连（ESP32-S3）」：把硬件队友通过 Wi-Fi 上传的可见光照片与热像显示出来
//
// 数据来源：tools/hardware-receiver.mjs（端口 5000）的两个路由
//   POST /upload          可见光 JPEG（固件 serverUrl）
//   POST /upload_thermal  JSON {max_temp, sensor_data:[768]}（固件 thermalServerUrl）
// 页面通过同源 /hw/* 代理读取（HTTPS 页面不能直接访问 http://host:5000）

import { useEffect, useState } from 'react'
import { Activity, Camera, Cpu, Flame, RefreshCw, Wifi } from 'lucide-react'

const POLL_MS = 2000

export default function HardwareFeed() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [online, setOnline] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('./hw/latest', { cache: 'no-store' })
        if (!response.ok) throw new Error(`http-${response.status}`)
        const payload = await response.json()
        if (cancelled) return
        setData(payload)
        setError('')
        setOnline(true)
      } catch (err) {
        if (cancelled) return
        setOnline(false)
        setError(String(err?.message ?? err))
      }
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [tick])

  const visible = data?.visible ?? null
  const thermal = data?.thermal ?? null
  const log = data?.log ?? []
  const hot = thermal && thermal.maxTemp >= (data?.yesTemp ?? 70)

  return (
    <section className="mobile-card hardware-card">
      <div className="card-head">
        <div>
          <strong>硬件直连 · ESP32-S3 热感探测器</strong>
          <small>Wi-Fi 上传可见光照片（/upload）与 768 点热像（/upload_thermal）</small>
        </div>
        <button type="button" className="hardware-refresh" onClick={() => setTick((value) => value + 1)}>
          <RefreshCw size={16} />
        </button>
      </div>

      {online === false && (
        <div className="hardware-offline">
          <Wifi size={15} />
          <div>
            <strong>还没连上硬件接收端</strong>
            <small>
              在跑本页的电脑上另开一个窗口执行：<code>node tools/hardware-receiver.mjs --port 5000</code>
              （macOS 若提示 5000 被占用，先关掉「隔空播放接收器」或用 <code>--port 5011</code> 并同步改固件端口）
            </small>
            {error && <em>当前错误：{error}</em>}
          </div>
        </div>
      )}

      {online && (
        <>
          <div className="hardware-grid">
            <figure className="hardware-frame">
              <figcaption><Camera size={14} />可见光 /upload</figcaption>
              {visible
                ? <img src={`./hw/latest.jpg?t=${visible.at}`} alt="硬件上传的可见光照片" />
                : <div className="hardware-empty">等待硬件上传照片…</div>}
              <p>
                {visible
                  ? `${new Date(visible.at).toLocaleTimeString('zh-CN')} · ${Math.round(visible.bytes / 1024)} KB · 终审 ${visible.decision}（${visible.source}）`
                  : '固件触发条件是 烟雾 > 2000 或 最高温 > 70°C'}
              </p>
            </figure>

            <figure className="hardware-frame">
              <figcaption><Flame size={14} />热像 /upload_thermal</figcaption>
              {thermal
                ? <img src={`./hw/thermal.png?t=${thermal.at}`} alt="硬件上传的热像图" />
                : <div className="hardware-empty">等待硬件上传热像…</div>}
              <p>
                {thermal
                  ? `${new Date(thermal.at).toLocaleTimeString('zh-CN')} · 最高 ${thermal.maxTemp.toFixed(1)}°C · ${thermal.points} 个温度点`
                  : 'MLX90640 · 32×24 温度矩阵'}
              </p>
            </figure>
          </div>

          <div className="hardware-stats">
            <div><span><Activity size={13} />热像最高温</span><strong className={hot ? 'is-hot' : ''}>{thermal ? `${thermal.maxTemp.toFixed(1)}°C` : '—'}</strong></div>
            <div><span><Cpu size={13} />报警阈值</span><strong>{data?.yesTemp ?? 70}°C</strong></div>
            <div><span><Flame size={13} />最近终审</span><strong>{visible ? visible.decision : '—'}</strong></div>
          </div>

          {log.length > 0 && (
            <ul className="hardware-log">
              {log.slice(0, 5).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className={entry.answer === 'YES' ? 'is-yes' : ''}>
                  <b>{entry.answer}</b>
                  <span>{new Date(entry.at).toLocaleTimeString('zh-CN')} · {entry.source}</span>
                  <em>{entry.reason}</em>
                </li>
              ))}
            </ul>
          )}

          <p className="situation-note">
            终审优先级：YOLO 视觉服务（若已配置）→ 热像阈值 → 保守返回 NO。
            固件只有在收到恰好 <code>YES</code> 时才拉响蜂鸣器并广播蓝牙告警包。
          </p>
        </>
      )}
    </section>
  )
}
