// 用户端「离线联通」：不依赖互联网也能跟系统端交换火警信息
//
//   收到火警：局域网中继（现场热点）自动收；断网时扫系统端二维码 / 粘贴事件码人工导入
//   上报情况：把"我这里看到火/我走不动/我身边有人受伤"发给系统端（中继可用时直达）

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Link2, QrCode, Send, Server, TriangleAlert, Upload } from 'lucide-react'
import {
  createEvent,
  decodeEventCode,
  describeTransport,
  encodeEventCode,
  makeCloudChannel,
  parseCloudChannel,
  readCloudChannel,
  readRelayBase,
  saveCloudChannel,
  saveRelayBase,
  sharedEventBus,
} from '../shared/eventBus.js'
import { isAutoJoinEnabled, setAutoJoinEnabled } from '../shared/geoChannels.js'

export default function OfflineLink({ floor, spot, nearestExit, onImportEvent, onReport }) {
  const bus = useMemo(() => sharedEventBus(), [])
  const [status, setStatus] = useState(() => bus.status())
  const [relayBase, setRelayBase] = useState(() => readRelayBase())
  const [cloudChannel, setCloudChannel] = useState(() => readCloudChannel())
  const [autoJoin, setAutoJoin] = useState(() => isAutoJoinEnabled())
  const [codeInput, setCodeInput] = useState('')
  const [message, setMessage] = useState('')
  const [scanning, setScanning] = useState(false)
  const [reportText, setReportText] = useState('')
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => {
    const timer = window.setInterval(() => setStatus(bus.status()), 1500)
    const unsubscribe = bus.onEvent((event) => {
      if (event.kind === 'fire' || event.kind === 'notice' || event.kind === 'clear') {
        const ok = onImportEvent?.(event)
        if (ok) setMessage(`已收到 ${event.kind === 'clear' ? '解除通知' : '火警事件'}（来自 ${event.from === 'code' ? '离线码' : '现场链路'}）`)
      }
    })
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [bus, onImportEvent])

  useEffect(() => () => stopScan(), [])

  function stopScan() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const applyCode = (raw) => {
    const event = decodeEventCode(raw)
    if (!event) {
      setMessage('这段事件码读不出来，请确认是从系统端「链路」面板完整复制/扫描的')
      return false
    }
    const ok = onImportEvent?.(event)
    setMessage(ok ? `已导入：${event.kind === 'fire' ? '火警' : event.kind === 'clear' ? '解除通知' : '现场通知'}（${new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}）` : '事件已过期或缺少火源位置，未导入')
    return ok
  }

  const startScan = async () => {
    setMessage('')
    setScanning(true)
    try {
      const { default: jsQR } = await import('jsqr')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
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
              setScanning(false)
              applyCode(found.data)
              return
            }
          } catch {}
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      stopScan()
      setScanning(false)
      setMessage('打不开摄像头：可以直接把系统端的事件码粘贴到下面的输入框')
    }
  }

  const sendReport = async (text) => {
    const payloadText = text || reportText || '用户上报火源或异常'
    // 发布统一由上层负责（UserApp），这里只把文案交上去，避免重复发布
    await onReport?.(payloadText)
    setReportText('')
    setMessage(bus.status().relayOk ? '已通过现场链路发给系统端' : '现场链路不可用：已保存在本机，可让系统端扫你屏幕上的事件码')
  }

  const myCode = encodeEventCode(createEvent('report', { floor, spot, text: reportText || '用户上报火源或异常', exitLabel: nearestExit ?? null }, { from: 'user' }))

  const applyRelay = () => {
    saveRelayBase(relayBase)
    bus.stop()
    window.location.reload()
  }

  const applyCloud = () => {
    saveCloudChannel(cloudChannel)
    bus.stop()
    window.location.reload()
  }

  return (
    <div className="more-body">
      <p className="more-hint">
        火场里网络可能被烧坏或干扰：这里先把链路说清楚，再给你两条不依赖互联网的路——
        现场热点中继，或者直接扫系统端的二维码。
      </p>

      <div className={`link-status level-${status.level}`}>
        <Link2 size={16} />
        <div>
          <strong>{describeTransport(status.level)}</strong>
          <small>
            云端通道：{status.cloudOk ? '在线' : status.cloudChannel ? '配置了但连不上' : '未配置'} ·
            局域网：{status.relayOk ? `在线${status.peers ? `（${status.peers} 台设备）` : ''}` : '不可用'} · 已收发 {status.events} 条
          </small>
        </div>
      </div>

      <h4 className="link-title"><Server size={14} />云端通道（手机用移动网络时走这条）</h4>
      <label className="ai-field">
        通道暗号（两端填同一个值）
        <input
          type="text"
          value={cloudChannel}
          placeholder="ntfy:热感哨兵-xxxxx 或 https://你的中继域名"
          onChange={(event) => setCloudChannel(event.target.value)}
        />
      </label>
      <div className="more-actions">
        <button type="button" onClick={() => setCloudChannel(makeCloudChannel())}>生成一个</button>
        <button type="button" className="more-primary" onClick={applyCloud}>保存云端通道</button>
      </div>
      <label className="ai-check">
        <input
          type="checkbox"
          checked={autoJoin}
          onChange={(event) => {
            setAutoJoin(event.target.checked)
            setAutoJoinEnabled(event.target.checked)
          }}
        />
        走到校园/小区范围内时自动加入该区域的警报频道（用定位判断，只在本机计算）
      </label>
      <p className="more-hint">
        系统端「链路」面板里点“生成一个新通道”，把那个值填到这里（或扫它的二维码）即可配对；
        留空表示不用云端，退回局域网/离线码。
      </p>

      <div className="link-relay">
        <label className="ai-field">
          局域网中继地址（可选，留空 = 当前站点同源）
          <input type="text" value={relayBase} placeholder="http://192.168.1.20:4173" onChange={(event) => setRelayBase(event.target.value)} />
        </label>
        <div className="more-actions">
          <button type="button" onClick={applyRelay}><Server size={14} />保存并重连</button>
        </div>
      </div>

      <h4 className="link-title"><QrCode size={14} />接收火警（不需要网络）</h4>
      <div className="more-actions">
        <button type="button" className="more-primary" onClick={startScan} disabled={scanning}>
          <Camera size={15} />{scanning ? '正在扫码…' : '扫码接收'}
        </button>
        <button type="button" onClick={() => applyCode(codeInput)} disabled={!codeInput.trim()}>
          <Upload size={15} />导入事件码
        </button>
      </div>
      {scanning && (
        <div className="link-scan">
          <video ref={videoRef} autoPlay playsInline muted />
          <canvas ref={canvasRef} hidden />
        </div>
      )}
      <textarea
        className="link-code-input"
        rows={3}
        placeholder="系统端事件码（TGS1-…）"
        value={codeInput}
        onChange={(event) => setCodeInput(event.target.value)}
      />

      <h4 className="link-title"><TriangleAlert size={14} />上报火源 / 求助</h4>
      <textarea
        className="link-code-input"
        rows={2}
        placeholder="例如：三楼东侧配电箱冒烟，我在 C 楼梯口"
        value={reportText}
        onChange={(event) => setReportText(event.target.value)}
      />
      <div className="more-actions">
        <button type="button" className="more-primary" onClick={() => sendReport()}>
          <Send size={15} />发给系统端（{floor} 楼 {spot}）
        </button>
        <button type="button" onClick={() => sendReport('我这里看到明火或浓烟')}>一键上报看到火</button>
      </div>
      <p className="more-hint">
        没有中继时，把下面这段码给系统端扫，或让系统端把它的码给你扫：
      </p>
      <textarea className="link-code-input" rows={2} readOnly value={myCode} onFocus={(event) => event.target.select()} />

      {message && <div className="more-notice">{message}</div>}
    </div>
  )
}
