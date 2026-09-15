// 系统端「链路」面板：看清用户端和系统端到底怎么连上的
//
// 三级链路（能用哪级用哪级）：
//   L1 同机同浏览器：BroadcastChannel + localStorage，两个页面直接互通；
//   L2 局域网中继  ：站点所在局域网内的 /sync/*（本地服务器，**不需要互联网**）；
//   L3 离线码      ：把事件编成短码，这里显示成二维码，用户端扫码导入，完全不需要网络。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link2, QrCode, RefreshCw, Server, Smartphone, X } from 'lucide-react'
import {
  describeTransport,
  createEvent,
  encodeEventCode,
  makeCloudChannel,
  mergeEvents,
  parseCloudChannel,
  readCloudChannel,
  readRelayBase,
  saveCloudChannel,
  saveRelayBase,
  sharedEventBus,
} from '../shared/eventBus.js'
import { buildJoinUrl } from '../shared/geoChannels.js'

export default function LinkSheet({ onClose, latestFire, noticeText }) {
  const bus = useMemo(() => sharedEventBus(), [])
  const [status, setStatus] = useState(() => bus.status())
  const [relayBase, setRelayBase] = useState(() => readRelayBase())
  const [cloudChannel, setCloudChannel] = useState(() => readCloudChannel())
  // 打开面板时先灌入总线里已有的事件，再接收后续新增
  const [events, setEvents] = useState(() => bus.recent())
  const [qr, setQr] = useState('')
  const [joinQr, setJoinQr] = useState('')
  const qrRef = useRef(null)
  // 从报警浮层点进来时，同一次点击可能"穿透"到刚挂载的遮罩上，导致面板被立刻关掉
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    const unsubscribe = bus.onEvent((event) => {
      setEvents((current) => mergeEvents(current, event))
      setStatus(bus.status())
    })
    const timer = window.setInterval(() => setStatus(bus.status()), 1500)
    bus.status()
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [bus])

  // 事件码：把最近一次火情（或一段提示）编成短码，再渲染成二维码
  const payloadEvent = useMemo(() => {
    if (latestFire?.nodeId) {
      return createEvent('fire', {
        nodeId: latestFire.nodeId,
        floor: latestFire.floor ?? null,
        startedAt: latestFire.startedAt ?? Date.now(),
        mode: latestFire.mode ?? 'live',
        ...(Array.isArray(latestFire.nodes) && latestFire.nodes.length > 1 ? { nodes: latestFire.nodes } : {}),
        notice: noticeText ?? '',
      }, { from: 'system' })
    }
    if (noticeText) return createEvent('notice', { text: noticeText }, { from: 'system' })
    return null
  }, [latestFire?.nodeId, latestFire?.floor, latestFire?.nodes, latestFire?.startedAt, latestFire?.mode, noticeText])

  const code = payloadEvent ? encodeEventCode(payloadEvent) : ''

  useEffect(() => {
    if (!code) {
      setQr('')
      return undefined
    }
    let cancelled = false
    import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(code, { margin: 1, width: 320, errorCorrectionLevel: 'M' }))
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => setQr(''))
    return () => {
      cancelled = true
    }
  }, [code])

  // 「扫码进入演示」二维码：扫码后用户端自动加入当前频道，不受网络环境影响
  const joinUrl = useMemo(() => {
    if (!cloudChannel || typeof window === 'undefined') return ''
    const base = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}user-app.html`
    return buildJoinUrl(base, cloudChannel)
  }, [cloudChannel])

  useEffect(() => {
    if (!joinUrl) {
      setJoinQr('')
      return undefined
    }
    let cancelled = false
    import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(joinUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' }))
      .then((url) => {
        if (!cancelled) setJoinQr(url)
      })
      .catch(() => setJoinQr(''))
    return () => {
      cancelled = true
    }
  }, [joinUrl])

  const applyRelay = async () => {
    saveRelayBase(relayBase)
    bus.stop()
    window.location.reload()
  }

  const applyCloud = () => {
    saveCloudChannel(cloudChannel)
    bus.stop()
    window.location.reload()
  }

  const cloudInfo = parseCloudChannel(cloudChannel)
  const pairCode = `TGS-PAIR:${cloudChannel}`.trim()

  const received = events.filter((event) => event.kind === 'report' || event.kind === 'status')

  return (
    <div
      className="sheet-backdrop"
      onClick={() => {
        if (Date.now() - mountedAt.current < 350) return
        onClose()
      }}
    >
      <section className="device-sheet link-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div><span>两端联通</span><strong>链路状态</strong></div>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className={`link-status level-${status.level}`}>
          <Link2 size={16} />
          <div>
            <strong>{status.label}</strong>
            <small>
              云端通道：{status.cloudOk ? `在线（${status.cloudChannel}）` : status.cloudChannel ? '配置了但连不上' : '未配置'} ·
              局域网中继：{status.relayOk ? `在线${status.peers ? `（${status.peers} 台设备）` : ''}` : '不可用'} ·
              本次已收发 {status.events} 条事件
            </small>
          </div>
        </div>

        <div className="link-cloud">
          <label>
            云端通道（住户手机走蜂窝网络也能收到，推荐）
            <input
              type="text"
              value={cloudChannel}
              placeholder="ntfy:热感哨兵-xxxxx 或 https://你的中继域名"
              onChange={(event) => setCloudChannel(event.target.value)}
            />
          </label>
          <div className="link-cloud-actions">
            <button type="button" onClick={() => setCloudChannel(makeCloudChannel())}>生成一个新通道</button>
            <button type="button" className="primary" onClick={applyCloud}>保存云端通道</button>
          </div>
          <p className="situation-note">
            <Server size={12} />
            留空表示不用云端。通道就是"双方约定的暗号"：两端填同一个值即可互通；把上面的值（或下面二维码）给另一台设备扫一下就能配对。
            {cloudInfo.mode === 'ntfy' ? '当前用 ntfy.sh 公共转发，零部署，适合原型演示。' : null}
            {cloudInfo.mode === 'rest' ? '当前指向你自己的中继（协议见 tools/relay-server.mjs 与 tools/relay-worker.mjs）。' : null}
          </p>
          {cloudChannel && (
            <textarea className="link-pair" rows={2} readOnly value={pairCode} onFocus={(event) => event.target.select()} />
          )}
        </div>

        {joinQr && (
          <div className="link-join">
            <div className="link-qr-head">
              <strong><QrCode size={14} />扫码进入演示（跨网络可用）</strong>
              <span>评委/住户扫码 → 用户端自动加入当前频道，不需要任何设置</span>
            </div>
            <img src={joinQr} alt="扫码加入演示二维码" />
            <textarea className="link-pair" rows={2} readOnly value={joinUrl} onFocus={(event) => event.target.select()} />
            <p className="situation-note">
              这个二维码里带了频道暗号：不管对方连的是校园网、家里 Wi-Fi 还是 4G/5G，
              扫进来就受本演示的系统端控制（系统端一触发演练，用户端就收到火警与位置）。
            </p>
          </div>
        )}

        <div className="link-relay">
          <label>
            局域网中继地址（可选，现场无互联网时的备用通道；留空 = 当前站点同源）
            <input
              type="text"
              value={relayBase}
              placeholder="例如 http://192.168.1.20:4173"
              onChange={(event) => setRelayBase(event.target.value)}
            />
          </label>
          <button type="button" onClick={applyRelay}><RefreshCw size={14} />保存并重连</button>
          <p className="situation-note">
            <Server size={12} />现场做法：一台电脑跑 <code>node tools/local-ai-server.mjs</code>，手机连这台电脑的热点后打开它的地址，
            用户端与系统端就能通过 <code>/sync/*</code> 互通——**不走互联网**。
          </p>
        </div>

        <div className="link-qr">
          <div className="link-qr-head">
            <strong><QrCode size={14} />离线事件码（完全不需要网络）</strong>
            <span>用户端「更多 → 离线联通」扫码或粘贴即可导入</span>
          </div>
          {qr ? (
            <>
              <img ref={qrRef} src={qr} alt="火警事件二维码" />
              <textarea readOnly value={code} rows={3} onFocus={(event) => event.target.select()} />
            </>
          ) : (
            <p className="situation-note">当前没有可下发的事件：先在系统端触发一次报警，或让阶段一生成一条通知。</p>
          )}
        </div>

        <div className="link-received">
          <strong><Smartphone size={14} />用户端上报（{received.length}）</strong>
          {received.length === 0 && <p className="situation-note">还没有收到用户端上报。用户端在火警问答里选择"需要帮助"，或点「上报火源」，这里就会出现。</p>}
          {received.map((event) => (
            <div className="link-received-row" key={event.id}>
              <span>{event.kind === 'report' ? '火源上报' : '人员状态'}</span>
              <div>
                <strong>{event.payload?.floor ?? '?'} 楼 {event.payload?.spot ?? ''}{event.payload?.text ? ` · ${event.payload.text}` : ''}</strong>
                <small>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })} · 来源 {event.from}</small>
              </div>
            </div>
          ))}
        </div>

        <p className="situation-note">
          <Link2 size={12} />三级链路说明：{describeTransport('local')} → {describeTransport('lan')} → {describeTransport('code')}。
          公网演示站（HTTPS）没有中继，只能用同机同浏览器或离线码；现场用本地服务器时自动升级到局域网中继。
        </p>
      </section>
    </div>
  )
}
