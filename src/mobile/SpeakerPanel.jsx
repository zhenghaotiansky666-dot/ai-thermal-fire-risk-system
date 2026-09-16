// 系统端「现场喇叭」：让楼道里"路过的人"也知道着火
//
// 为什么不做 App：浏览器的 Web Bluetooth 只能"主动去连设备"，不能被动监听广播，
// 所以"走进范围自动弹通知"只有原生 App 能做到——但它只对"已经装了 App 的人"有效，
// 而这些人本来就会收到用户端推送。真正决定"路人能不能知道"的是他能不能听见/看见。
//
// 这个面板做的事：给一台旧手机/平板（+ 音箱）发一张二维码，扫码打开 alarm-speaker.html
// 点「开始值守」放在楼道口，火警时整页变红 + 警笛 + 中文播报起火位置。

import { useEffect, useMemo, useRef, useState } from 'react'
import { BellOff, Megaphone, QrCode, RefreshCw, Smartphone, Volume2, Wifi } from 'lucide-react'
import { createEvent, readCloudChannel, readRelayBase, sharedEventBus } from '../shared/eventBus.js'

// 喇叭页每 15 秒发一次心跳；超过 45 秒没心跳就算离岗
const HEARTBEAT_TTL_MS = 45000
const NAME_KEY = 'thermalGuardSpeakerName'

function readSpeakerName() {
  try {
    return localStorage.getItem(NAME_KEY) || ''
  } catch {
    return ''
  }
}

export default function SpeakerPanel({ fire, fireText, onToast }) {
  const bus = useMemo(() => sharedEventBus(), [])
  const [name, setName] = useState(() => readSpeakerName() || '本楼')
  const [qr, setQr] = useState('')
  const [speakers, setSpeakers] = useState([])
  const [lastNotice, setLastNotice] = useState(null)
  const [tick, setTick] = useState(0)
  const beatsRef = useRef(new Map())

  const collectSpeakers = () => {
    const now = Date.now()
    const list = []
    beatsRef.current.forEach((at, key) => {
      if (now - at > HEARTBEAT_TTL_MS) {
        beatsRef.current.delete(key)
        return
      }
      list.push({ key, at })
    })
    list.sort((a, b) => b.at - a.at)
    setSpeakers(list)
  }

  useEffect(() => {
    bus.start()
    // 进面板先把总线里已有的心跳灌进来，再从这一刻起接收新的
    bus.recent().forEach((event) => {
      if (event.from === 'speaker') beatsRef.current.set(event.payload?.name || '本楼', Number(event.at) || Date.now())
    })
    collectSpeakers()
    const unsubscribe = bus.onEvent((event) => {
      if (event.from === 'speaker') {
        beatsRef.current.set(event.payload?.name || '本楼', Number(event.at) || Date.now())
        collectSpeakers()
        return
      }
      if (event.kind === 'notice' || event.kind === 'fire' || event.kind === 'clear') {
        setLastNotice(event)
      }
    })
    const sweep = window.setInterval(collectSpeakers, 5000)
    return () => {
      unsubscribe()
      window.clearInterval(sweep)
    }
  }, [bus])

  const speakerUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    const base = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}alarm-speaker.html`
    const url = new URL(base)
    if (name.trim()) url.searchParams.set('name', name.trim())
    const relay = readRelayBase()
    if (relay) url.searchParams.set('relay', relay.replace(/\/$/, ''))
    const cloud = readCloudChannel()
    if (cloud) url.searchParams.set('ch', cloud)
    return url.toString()
  }, [name, tick])

  useEffect(() => {
    if (!speakerUrl) {
      setQr('')
      return undefined
    }
    let cancelled = false
    import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(speakerUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' }))
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => setQr(''))
    return () => {
      cancelled = true
    }
  }, [speakerUrl])

  const saveName = (value) => {
    setName(value)
    try {
      localStorage.setItem(NAME_KEY, value)
    } catch {
      /* 隐私模式忽略 */
    }
  }

  const speak = async (text, kind = 'notice') => {
    if (!bus.status().relayOk && !readCloudChannel()) {
      onToast?.('喇叭页要靠局域网中继或云端通道：先在链路面板配好其中一条')
    }
    await bus.publish(createEvent(kind, kind === 'notice' ? { text } : {}, { from: 'system' }))
    setLastNotice({ kind, at: Date.now(), payload: { text } })
    onToast?.('播报指令已发出，楼道喇叭页会立刻喊话')
  }

  const fireLabel = fireText || (fire ? `${fire.floor ?? ''} 楼发生火情` : '')
  const relayOk = bus.status().relayOk
  const cloud = readCloudChannel()
  const nowText = lastNotice ? new Date(lastNotice.at).toLocaleTimeString('zh-CN', { hour12: false }) : '暂无'

  return (
    <section className="mobile-card speaker-card">
      <div className="card-head">
        <div>
          <strong>现场喇叭 · 路过的人也能知道</strong>
          <small>旧手机 + 音箱放楼道口，扫码即用：整页变红 + 警笛 + 中文播报起火位置</small>
        </div>
        <button type="button" className="hardware-refresh" onClick={() => setTick((value) => value + 1)}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="speaker-body">
        <div className="speaker-qr">
          {qr ? <img src={qr} alt="现场喇叭页二维码" /> : <div className="speaker-qr-empty"><QrCode size={22} /></div>}
          <small>扫这张码 → 打开喇叭页</small>
        </div>
        <div className="speaker-steps">
          <span><b>①</b>找一台旧手机 / 平板，连现场 Wi-Fi 或热点（不用装 App）</span>
          <span><b>②</b>扫码打开本页 → 点「开始值守」→ 插上音箱放楼道口</span>
          <span><b>③</b>系统端一报警，这里就整页变红喊话；点「解除警报」自动恢复</span>
        </div>
      </div>

      <label className="speaker-name">
        本楼名称（会出现在播报里）
        <input value={name} onChange={(event) => saveName(event.target.value)} placeholder="例如：R 座 / 三楼东侧" />
      </label>
      <textarea className="link-pair" rows={2} readOnly value={speakerUrl} onFocus={(event) => event.target.select()} />

      <div className="hardware-stats">
        <div>
          <span><Smartphone size={13} />值守设备</span>
          <strong className={speakers.length > 0 ? 'is-live' : ''}>
            {speakers.length > 0 ? `${speakers.length} 台` : '暂无'}
          </strong>
        </div>
        <div>
          <span><Wifi size={13} />取数通道</span>
          <strong>{relayOk ? '局域网中继' : cloud ? '云端' : '未配置'}</strong>
        </div>
        <div>
          <span><Volume2 size={13} />最近播报</span>
          <strong>{nowText}</strong>
        </div>
      </div>

      <div className="speaker-actions">
        <button type="button" onClick={() => speak(`这是${name.trim() || '本楼'}现场喇叭的一次演练播报，听到请不必惊慌`)}>
          <Volume2 size={14} />试播一次
        </button>
        <button type="button" className="primary" disabled={!fire && !fireText} onClick={() => speak(fireLabel ? `${fireLabel}，请立即沿安全出口撤离` : '请立即沿安全出口撤离')}>
          <Megaphone size={14} />重播当前火情
        </button>
        <button type="button" onClick={() => speak('', 'clear')}>
          <BellOff size={14} />解除警报
        </button>
      </div>

      <p className="situation-note">
        <Megaphone size={12} />这一层覆盖"不认识我们的人"：不需要装 App、不需要互联网（现场热点即可），
        配合硬件节点自己的蜂鸣器与电脑端语音播报，就是"声 + 光 + 语音"三件套。
        硬件固件本来就在广播 BLE 告警包，所以将来真要做"路过弹通知"的原生 App，硬件一行都不用改。
      </p>
      <p className="situation-note">
        <Wifi size={12} />喇叭页与用户端共用同一条链路：局域网中继 <code>/sync</code>（无网可用）或云端通道
        <code> ntfy:主题</code>（跨网络）。对着的是没有网络的现场，就选前者。
      </p>
    </section>
  )
}
