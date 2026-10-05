// 从队友 957cb3b / 6293377 挑过来的三块功能（巡检、隐患上报、PDF 处置报告），
// 按我们这一版的风格与数据口径重写：图标、文案、报告抬头改成「FireAegis」，
// 巡检记录与隐患记录都只存在本机 localStorage，不依赖后端。

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileText,
  Info,
  QrCode,
  ScanLine,
  Send,
  X,
} from 'lucide-react'
import jsQR from 'jsqr'

// ---------------------------------------------------------------- 二维码扫描取景器
export function QrScanModal({ onClose, onDetected }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const [status, setStatus] = useState('starting')
  const [msg, setMsg] = useState('正在打开摄像头…')

  useEffect(() => {
    let cancelled = false

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    const detectFrame = () => {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const scale = Math.min(1, 640 / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        try {
          const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
          if (code?.data) {
            stop()
            onDetected(code.data)
            return
          }
        } catch {}
      }
      rafRef.current = requestAnimationFrame(detectFrame)
    }

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setStatus('error')
          setMsg('当前浏览器不支持摄像头，请手动「登记」或改用 Chrome')
          return
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setStatus('scanning')
        setMsg('请对准消防设施上的二维码')
        detectFrame()
      } catch {
        if (!cancelled) {
          setStatus('error')
          setMsg('无法打开摄像头，请允许相机权限后重试；也可以手动登记')
        }
      }
    }

    start()
    return () => {
      cancelled = true
      stop()
    }
  }, [onDetected])

  return (
    <div className="scan-backdrop" onClick={onClose}>
      <section className="scan-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="scan-head">
          <div><strong>扫码巡检</strong><small>对准设施二维码自动识别</small></div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="scan-stage">
          <video ref={videoRef} className="scan-video" autoPlay playsInline muted />
          <canvas ref={canvasRef} hidden />
          <div className="scan-frame"><i /><span className="scan-beam" /></div>
          {status === 'error' && <div className="scan-error">{msg}</div>}
        </div>
        <p className="scan-status">
          {status === 'error' ? msg : status === 'starting' ? '正在启动摄像头…' : '正在扫描二维码…'}
        </p>
        <div className="scan-actions">
          <button type="button" onClick={onClose}>取消</button>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- 消防设施巡检
const FACILITIES = [
  { id: 'f1', name: '灭火器', code: 'A-01', location: '图书馆 1F 东侧', expire: '2027-06', status: '正常' },
  { id: 'f2', name: '室内消火栓', code: 'B-03', location: '教学楼 B 3F 走廊', expire: '2027-01', status: '正常' },
  { id: 'f3', name: '应急照明', code: 'C-12', location: '综合大楼 2F 楼梯间', expire: '2026-12', status: '临近到期' },
  { id: 'f4', name: '疏散指示', code: 'D-07', location: 'P 座宿舍 5F 出口', expire: '2027-09', status: '正常' },
]

const INSPECTION_KEY = 'thermalGuardInspections'

export function InspectionPanel() {
  const [records, setRecords] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(INSPECTION_KEY) || 'null')
      return Array.isArray(saved) && saved.length ? saved : FACILITIES
    } catch {
      return FACILITIES
    }
  })
  const [scanOpen, setScanOpen] = useState(false)
  const [scanMsg, setScanMsg] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(INSPECTION_KEY, JSON.stringify(records))
    } catch {}
  }, [records])

  const nowStamp = () => new Date().toLocaleString('zh-CN', { hour12: false })
  const markInspected = (id) => setRecords((current) => current.map((item) => (
    item.id === id ? { ...item, status: '正常', last: nowStamp(), checks: (item.checks || 0) + 1 } : item
  )))

  const handleDetected = (data) => {
    const code = String(data || '').trim()
    const found = records.find((item) => (
      item.code.toUpperCase() === code.toUpperCase()
      || code.toUpperCase().includes(item.code.toUpperCase())
      || code.includes(item.name)
    ))
    if (found) {
      markInspected(found.id)
      setScanMsg(`识别成功：${found.name} ${found.code} 已登记检查`)
    } else {
      setScanMsg(`未匹配到设施：${code || '空二维码'}，二维码内容请用设施编号（如 A-01）`)
    }
    setScanOpen(false)
  }

  return (
    <section className="mobile-card inspection-card">
      <div className="card-head">
        <div><strong>消防设施扫码巡检</strong><small>对准二维码自动识别，登记检查与到期提醒</small></div>
        <QrCode size={18} />
      </div>
      <button type="button" className="inspection-scan" onClick={() => { setScanMsg(''); setScanOpen(true) }}>
        <ScanLine size={15} />扫码检查
      </button>
      {scanMsg && (
        <p className={`inspection-scan-msg ${scanMsg.startsWith('识别成功') ? 'ok' : ''}`}>{scanMsg}</p>
      )}
      <div className="inspection-list">
        {records.map((item) => {
          const soon = item.status === '临近到期'
          return (
            <div className={`inspection-row ${soon ? 'warn' : ''}`} key={item.id}>
              <span className="inspection-icon"><QrCode size={15} /></span>
              <div>
                <strong>{item.name} · {item.code}</strong>
                <small>{item.location}{item.last ? ` · 上次检查 ${item.last}` : ' · 尚未登记'}</small>
                <em>有效期至 {item.expire}{item.checks ? ` · 已检 ${item.checks} 次` : ''}</em>
              </div>
              <button type="button" onClick={() => markInspected(item.id)}><CheckCircle2 size={14} />登记</button>
            </div>
          )
        })}
      </div>
      <p className="situation-note">
        <Info size={12} />二维码内容示例：A-01。没有二维码时可点「登记」手动补录；记录只存在本机。
      </p>
      {scanOpen && <QrScanModal onClose={() => setScanOpen(false)} onDetected={handleDetected} />}
    </section>
  )
}

// ---------------------------------------------------------------- 隐患随手拍上报
const HAZARD_KEY = 'thermalGuardHazards'

export function HazardReport() {
  const [items, setItems] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(HAZARD_KEY) || '[]')
    } catch {
      return []
    }
  })
  const [desc, setDesc] = useState('')
  const [loc, setLoc] = useState('')
  const [img, setImg] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    try {
      localStorage.setItem(HAZARD_KEY, JSON.stringify(items))
    } catch {}
  }, [items])

  const pickImage = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImg(String(reader.result))
    reader.readAsDataURL(file)
  }

  const submit = () => {
    if (!desc.trim() && !loc.trim()) return
    const next = [{
      id: `hz-${Date.now()}`,
      desc: desc.trim() || '未描述',
      loc: loc.trim() || '未填写位置',
      img,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    }, ...items].slice(0, 20)
    setItems(next)
    setDesc('')
    setLoc('')
    setImg('')
  }

  const remove = (id) => setItems((current) => current.filter((item) => item.id !== id))

  return (
    <section className="mobile-card hazard-card">
      <div className="card-head">
        <div><strong>隐患随手拍上报</strong><small>拍照记录隐患位置，纳入待处理清单</small></div>
        <Camera size={18} />
      </div>
      <div className="hazard-form">
        <input value={loc} onChange={(event) => setLoc(event.target.value)} placeholder="隐患位置，例如：三楼配电箱旁" />
        <textarea value={desc} onChange={(event) => setDesc(event.target.value)} placeholder="隐患描述，例如：线路发热、堆放可燃物" rows={2} />
        <div className="hazard-photo-row">
          <button type="button" onClick={() => fileRef.current?.click()}>
            <Camera size={14} />{img ? '更换照片' : '拍照 / 选图'}
          </button>
          {img && <img className="hazard-thumb" src={img} alt="隐患照片" />}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={pickImage} style={{ display: 'none' }} />
        </div>
        <button type="button" className="hazard-submit" onClick={submit}><Send size={14} />提交隐患</button>
      </div>
      {items.length > 0 && (
        <div className="hazard-list">
          {items.map((item) => (
            <div className="hazard-row" key={item.id}>
              <span><AlertTriangle size={14} /></span>
              <div><strong>{item.loc}</strong><p>{item.desc}</p><small>{item.time}</small></div>
              {item.img && <img src={item.img} alt="" />}
              <button type="button" className="hazard-remove" onClick={() => remove(item.id)} aria-label="删除该隐患">×</button>
            </div>
          ))}
        </div>
      )}
      <p className="situation-note">
        <Info size={12} />照片与文字只存在本机浏览器，用于把「看到的问题」变成可跟进的清单。
      </p>
    </section>
  )
}

// ---------------------------------------------------------------- PDF 处置报告（打印为 PDF）
function reportHtml(report) {
  const row = (label, value) => `<tr><td class="k">${label}</td><td>${value}</td></tr>`
  const tone = report.risk === 'high' ? '#dc2626' : report.risk === 'medium' ? '#d97706' : '#16a34a'
  return `
  <h1>FireAegis · 应急处置报告</h1>
  <div class="sub">${report.system} · 生成时间 ${report.generatedAt}</div>
  <h2>一、风险概况</h2><table>
  ${row('检测位置', report.location)}
  ${row('风险等级', `<span class="risk" style="background:${tone}">${report.riskLabel}</span>`)}
  ${row('风险指数', `${report.riskIndex} / 100`)}
  ${row('最高温度', `${Number(report.maxTemp || 0).toFixed(1)}°C`)}
  ${row('高温区域', `${report.hotspotCount} 处`)}
  </table>
  <h2>二、疏散建议</h2><table>
  ${row('推荐出口', report.recommendedExit ?? '最近安全出口')}
  ${row('疏散距离', report.evacuationDistance != null ? `${report.evacuationDistance} 米` : '—')}
  ${row('预计用时', report.evacuationEta != null ? `${report.evacuationEta} 秒` : '—')}
  ${row('未撤离人数', report.occupancy != null ? `${report.occupancy} 人` : '—')}
  </table>
  <h2>三、处置建议</h2>
  <p>立即核查高温区域电源与可燃物，启动声光报警与应急广播，按用户端给出的绿色路线组织疏散，同步拨打 119。持续监测温度趋势，留存全过程证据链，事后在「预警记录」中回溯起火原因与蔓延过程。</p>
  ${report.notes ? `<h2>四、现场记录</h2><p>${report.notes}</p>` : ''}
  <div class="footer">
    本报告由「FireAegis」系统自动生成，仅用于科研演示与校内管理，不替代专业消防检测与处置。<br />
    项目：面向校园与公共建筑的 AI 热感火警预警与动态疏散系统 · FireAegis 项目组
  </div>`
}

const REPORT_STYLE = `
  .pdf-report{width:794px;padding:42px 48px;background:#fff;color:#0f172a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}
  .pdf-report h1{font-size:26px;margin:0 0 6px}
  .pdf-report .sub{color:#64748b;font-size:13px;margin-bottom:20px}
  .pdf-report h2{font-size:17px;color:#1d4ed8;border-left:5px solid #3b82f6;padding-left:10px;margin:22px 0 10px}
  .pdf-report table{width:100%;border-collapse:collapse;font-size:14px}
  .pdf-report td{padding:10px 12px;border:1px solid #e2e8f0}
  .pdf-report td.k{width:150px;background:#f8fafc;color:#475569}
  .pdf-report .risk{display:inline-block;padding:3px 12px;border-radius:999px;color:#fff;font-weight:700}
  .pdf-report .footer{margin-top:28px;color:#94a3b8;font-size:12px;line-height:1.7}
`

// 真·PDF：把报告排版渲染到离屏画布，再按 A4 分页写进 PDF 并直接下载。
// 不用弹窗，所以不会被浏览器的弹窗拦截挡掉；中文由浏览器字体渲染，不会缺字。
export async function exportIncidentPdf(report) {
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1;background:#fff'
  const style = document.createElement('style')
  style.textContent = REPORT_STYLE
  const article = document.createElement('article')
  article.className = 'pdf-report'
  article.innerHTML = reportHtml(report)
  holder.append(style, article)
  document.body.appendChild(holder)
  try {
    const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
      import('jspdf'),
      import('html2canvas'),
    ])
    const canvas = await html2canvas(article, { scale: 2, backgroundColor: '#ffffff', logging: false })
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const imageHeight = (canvas.height * pageWidth) / canvas.width
    const image = canvas.toDataURL('image/jpeg', 0.92)
    let offset = 0
    pdf.addImage(image, 'JPEG', 0, 0, pageWidth, imageHeight)
    let remaining = imageHeight - pageHeight
    while (remaining > 0) {
      offset -= pageHeight
      pdf.addPage()
      pdf.addImage(image, 'JPEG', 0, offset, pageWidth, imageHeight)
      remaining -= pageHeight
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    pdf.save(`FireAegis-应急处置报告-${stamp}.pdf`)
    return true
  } finally {
    holder.remove()
  }
}

export function openPdfReport(report) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>FireAegis · 应急处置报告</title>
  <style>body{margin:0;padding:24px;background:#f1f5f9}${REPORT_STYLE}</style></head><body>
  <article class="pdf-report">${reportHtml(report)}</article>
  </body></html>`
  const win = window.open('', '_blank')
  if (win) {
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => {
      try {
        win.print()
      } catch {}
    }, 350)
    return true
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  return false
}

export function ReportButton({ className = '', label = '导出处置报告（PDF）', build, onDone }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        const report = build()
        try {
          await exportIncidentPdf(report)
          onDone?.('saved')
        } catch {
          // 极端情况下（例如浏览器不支持 canvas 导出）退回「打印成 PDF」
          const opened = openPdfReport(report)
          onDone?.(opened ? 'print' : 'failed')
        } finally {
          setBusy(false)
        }
      }}
    >
      <FileText size={16} />{busy ? '正在生成…' : label}
    </button>
  )
}
