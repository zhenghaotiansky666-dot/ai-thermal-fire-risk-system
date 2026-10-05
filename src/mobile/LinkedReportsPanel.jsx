// 系统端「用户端联动」面板
//
// 数据来源有两条，缺一条都能用：
//   1) 本机 localStorage —— 同一台设备上开了用户端（含跨标签页），直接互见；
//   2) 事件总线 —— 用户端在手机上扫码加入演练后，隐患照片/求助会经
//      局域网中继或云端通道送到这里（跨设备）。
// 收到的事件会写回 localStorage，和系统端自己的「隐患随手拍」共用一份清单。

import { useEffect, useState } from 'react'
import { AlertTriangle, Image as ImageIcon, Info, Link2, ShieldAlert } from 'lucide-react'
import { sharedEventBus } from '../shared/eventBus.js'
import { readUserStatuses, saveUserStatus } from '../user/binaryDialogue.js'
import {
  addHazard,
  hazardFromEvent,
  helpFromEvent,
  readHazards,
} from '../shared/userReports.js'

const MAX_HELP_ROWS = 3
const MAX_HAZARD_ROWS = 5

function readLocal() {
  return { hazards: readHazards(), statuses: readUserStatuses() }
}

// 用户端发来的求助落盘（结构就是 saveUserStatus 期望的形状），
// 这样救援端/阶段二面板读到的是同一份数据。
function persistHelp(payload) {
  if (!payload?.id) return
  saveUserStatus({
    id: String(payload.id),
    floor: payload.floor ?? null,
    spot: payload.spot ?? null,
    needsHelp: Boolean(payload.needsHelp),
    tone: payload.tone ?? '',
    advice: payload.advice ?? '',
    labels: Array.isArray(payload.labels) ? payload.labels : [],
    updatedAt: Number(payload.updatedAt) || Date.now(),
  })
}

export default function LinkedReportsPanel() {
  const [{ hazards, statuses }, setData] = useState(readLocal)

  useEffect(() => {
    const refresh = () => setData(readLocal())
    refresh()

    // 同一设备跨标签页：用户端写入 localStorage 后立刻刷新
    const onStorage = (event) => {
      if (!event.key || ['thermalGuardHazards', 'thermalGuardUserStatus'].includes(event.key)) refresh()
    }
    window.addEventListener('storage', onStorage)
    const timer = window.setInterval(refresh, 4000)

    // 跨设备：用户端上报经事件总线到达
    const bus = sharedEventBus()
    bus.start()
    const unsubscribe = bus.onEvent((event) => {
      const hazard = hazardFromEvent(event)
      if (hazard) {
        addHazard(hazard)
        refresh()
        return
      }
      const help = helpFromEvent(event)
      if (help) {
        persistHelp(help)
        refresh()
        return
      }
      // 用户端求助也会走 kind='status' 的老通道，同样落盘
      if (event.kind === 'status' && event.from !== 'system') {
        persistHelp(event.payload)
        refresh()
      }
    })

    return () => {
      unsubscribe()
      window.removeEventListener('storage', onStorage)
      window.clearInterval(timer)
    }
  }, [])

  const total = hazards.length + statuses.length

  return (
    <section className="mobile-card linked-card" data-testid="linked-reports">
      <div className="card-head">
        <div><strong>用户端联动</strong><small>用户端上报的隐患与求助汇总到这里</small></div>
        <Link2 size={18} />
      </div>
      <div className="linked-badge">
        <i className={total ? 'online' : ''} />
        {total ? `已收到 ${total} 条用户端数据` : '暂无用户端上报 · 用户端扫码加入后自动同步'}
      </div>

      {statuses.slice(0, MAX_HELP_ROWS).map((status) => (
        <div className="linked-row is-help" key={status.id}>
          <span className="linked-icon"><ShieldAlert size={16} /></span>
          <div>
            <strong>
              用户求助 · {status.floor ? `${status.floor} 楼` : '位置未知'}
              {status.needsHelp ? '（需要帮助）' : ''}
            </strong>
            <small>{status.advice || '已提交自救问答'}</small>
          </div>
          <em>{new Date(status.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</em>
        </div>
      ))}

      {hazards.slice(0, MAX_HAZARD_ROWS).map((hazard) => (
        <div className="linked-row" key={hazard.id}>
          {hazard.img
            ? <img className="linked-thumb" src={hazard.img} alt="用户端上报照片" loading="lazy" />
            : <span className="linked-icon"><AlertTriangle size={16} /></span>}
          <div>
            <strong>用户上报隐患 · {hazard.loc}</strong>
            <small>{hazard.desc} · {hazard.time}</small>
          </div>
          <em>{hazard.img ? '照片' : '文字'}</em>
        </div>
      ))}

      {total === 0 && (
        <div className="linked-empty">
          <ImageIcon size={26} />
          <p>在用户端「更多 → 隐患上报」拍照提交，这里会立刻出现该照片与记录。</p>
        </div>
      )}
      <p className="linked-note">
        <Info size={12} />
        同一设备两端直接共享；用户端扫码加入演练后，跨设备也会实时汇总到这里。
      </p>
    </section>
  )
}
