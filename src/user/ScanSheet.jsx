// 用户端左下角「扫一扫」：扫描演示中心 / 系统端的二维码，直接加入对方发起的演练
//
// 为什么要单独拎出来：现场最常用的动作就是"评委扫一下系统端的演练二维码"。
// 放在左下角（原来"演练"的位置），一步就能扫；本机自测演练挪到下面的次要按钮。

import { useEffect, useRef, useState } from 'react'
import { Camera, Keyboard, Link2, PlayCircle, RefreshCw, X } from 'lucide-react'
import { extractChannelFromSearch } from '../shared/geoChannels.js'
import { parseCloudChannel, readCloudChannel, saveCloudChannel, sharedEventBus } from '../shared/eventBus.js'

function parseJoinInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  // 支持三种输入：完整链接（带 ?ch=）、裸频道值（ntfy:xxx / https://relay#group）、以及二维码里整串文本
  const fromQuery = extractChannelFromSearch(text.includes('?') ? text.slice(text.indexOf('?')) : '')
  if (fromQuery) return fromQuery
  if (/^(ntfy:|https?:\/\/)/.test(text)) return text
  return ''
}

export default function ScanSheet({ onClose, onJoined, onSelfDrill, fireActive = false }) {
  const [tab, setTab] = useState('scan')
  const [manual, setManual] = useState('')
  const [message, setMessage] = useState('')
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => () => stopScan(), [])

  function stopScan() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setScanning(false)
  }

  const apply = (raw) => {
    const channel = parseJoinInput(raw)
    if (!channel) {
      setMessage('没认出二维码里的频道。请扫系统端「链路 → 扫码进入演示」或演示中心的二维码，也可以手动粘贴。')
      return false
    }
    if (parseCloudChannel(channel).mode === 'off') {
      setMessage('这个频道格式不对（应形如 ntfy:tg-xxx 或 https://你的域名#分组）。')
      return false
    }
    const previous = readCloudChannel()
    saveCloudChannel(channel)
    if (previous !== channel) {
      sharedEventBus().stop()
    }
    setMessage('已加入系统端的演练频道，正在同步…')
    onJoined?.(channel)
    window.setTimeout(() => window.location.reload(), 600)
    return true
  }

  const startScan = async () => {
    setMessage('')
    setScanning(true)
    try {
      const { default: jsQR } = await import('jsqr')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      const tick = () => {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (video && canvas && video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 640 / video.videoWidth)
          canvas.width = Math.round(video.videoWidth * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
          try {
            const found = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
            if (found?.data) {
              stopScan()
              apply(found.data)
              return
            }
          } catch {}
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      stopScan()
      setMessage('打不开摄像头：可以手动粘贴二维码链接，或在浏览器里允许相机权限后重试。')
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="position-sheet scan-sheet-user" role="dialog" aria-modal="true" aria-label="扫码加入演练" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="scan-user-head">
          <div>
            <span>演练 · 扫一扫</span>
            <strong>扫系统端二维码，加入这场演练</strong>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="scan-user-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'scan'} className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
            <Camera size={14} />扫码
          </button>
          <button type="button" role="tab" aria-selected={tab === 'manual'} className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>
            <Keyboard size={14} />手动输入
          </button>
        </div>

        {tab === 'scan' && (
          <div className="scan-user-body">
            <div className={`scan-user-stage ${scanning ? 'is-live' : ''}`}>
              <video ref={videoRef} className="scan-user-video" autoPlay playsInline muted />
              <canvas ref={canvasRef} hidden />
              {!scanning && (
                <div className="scan-user-placeholder">
                  <Camera size={26} />
                  <p>点下面「开始扫码」，对准系统端或演示中心的二维码</p>
                </div>
              )}
              {scanning && <div className="scan-user-frame"><i /><span className="scan-user-beam" /></div>}
            </div>
            {scanning
              ? <button type="button" className="scan-user-secondary" onClick={stopScan}>停止扫码</button>
              : <button type="button" className="scan-user-primary" onClick={startScan}><Camera size={16} />开始扫码</button>}
          </div>
        )}

        {tab === 'manual' && (
          <div className="scan-user-body">
            <label className="scan-user-field">
              粘贴二维码里的链接或频道
              <textarea
                rows={3}
                value={manual}
                placeholder="例如 https://…/user-app.html?ch=ntfy%3Atg-demo-xxxx 或 ntfy:tg-demo-xxxx"
                onChange={(event) => setManual(event.target.value)}
              />
            </label>
            <button type="button" className="scan-user-primary" onClick={() => apply(manual)}>
              <Link2 size={16} />加入这场演练
            </button>
          </div>
        )}

        {message && <div className="scan-user-message">{message}</div>}

        <div className="scan-user-self">
          <div>
            <strong>没有系统端在跑？</strong>
            <small>可以在这台手机上自己起一次演练，用来检查界面与播报（不影响系统端频道）。</small>
          </div>
          <button type="button" onClick={() => { onSelfDrill?.(); onClose?.() }}>
            <PlayCircle size={15} />{fireActive ? '结束本机演练' : '本机演练'}
          </button>
        </div>
        <button type="button" className="scan-user-refresh" onClick={() => window.location.reload()}>
          <RefreshCw size={14} />重新加载页面
        </button>
      </section>
    </div>
  )
}
