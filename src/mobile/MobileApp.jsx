import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Box,
  BellRing,
  Cable,
  Smartphone,
  Camera,
  CheckCircle2,
  ChevronRight,
  Compass,
  CircleDot,
  Clock3,
  Cpu,
  Crosshair,
  Database,
  Edit3,
  Eye,
  Copy,
  Globe2,
  Maximize2,
  Video,
  Flame,
  Gauge,
  Image as ImageIcon,
  Info,
  Layers3,
  Link2,
  LoaderCircle,
  LocateFixed,
  Map,
  MapPin,
  Navigation,
  Plus,
  RadioTower,
  Radio,
  RotateCcw,
  Rotate3D,
  Route,
  Save,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Thermometer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Upload,
  Volume2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'

import AlarmCenterView from './AlarmCenterView.jsx'
import AlarmOverlay from './AlarmOverlay.jsx'
import AiCommandSheet from './AiCommandSheet.jsx'
import { HazardReport, InspectionPanel, ReportButton, exportIncidentPdf, openPdfReport } from './EmergencyPanels.jsx'
import { PreventionPanel, RescueBriefPanel, VitalSignsPanel, copyNotice } from './PhasePanels.jsx'
import HardwareFeed from './HardwareFeed.jsx'
import { aiCommand, readAiSettings } from '../shared/aiClient.js'
import { readUserStatuses } from '../user/binaryDialogue.js'
import LinkSheet from './LinkSheet.jsx'
import { createEvent, fireFromEvent, peerReportSummary, sharedEventBus } from '../shared/eventBus.js'
import CityMap from './CityMap.jsx'
import EvacuationView from './EvacuationView.jsx'
import { SPOT_MAPPING_NOTE, campusLocationForNode } from './campus.js'
import { advanceCrowd, createCrowdState } from './crowd.js'

// 3D 引擎（three.js）体积较大，只有打开校园三维视图时才加载
const Campus3D = lazy(() => import('./Campus3D.jsx'))
import { BUILDING, FLOOR_COUNT, positionNodeId } from './building.js'
import ArNavigator from '../user/ArNavigator.jsx'
import { planRoute } from './evacuation.js'
import { DEFAULT_THRESHOLDS, createFrame, normalizePacket, riskFromMaxTemp } from './thermal.js'
import {
  ALARM_VIBRATION_INTERVAL,
  isAudioUnlocked,
  speak,
  startSiren,
  stopSpeak,
  stopSiren,
  stopVibrate,
  supportsVibration,
  unlockAudio,
  vibrateAlarm,
} from './alarm.js'

const DEMO_THERMAL = `${import.meta.env.BASE_URL}demo-thermal.jpg`
const DEMO_LIVE = `${import.meta.env.BASE_URL}demo-live.gif`

const tabs = [
  { id: 'home', label: '检测', navLabel: '首页检测', icon: ScanLine },
  { id: 'map', label: '地图', navLabel: '城市热力', icon: Map },
  { id: 'camera', label: '监控', navLabel: '现场监控', icon: Video },
  { id: 'alerts', label: '预警', navLabel: '预警记录', icon: BellRing },
  { id: 'evacuation', label: '逃生', navLabel: '逃生指引', icon: Navigation },
  { id: 'dashboard', label: '看板', navLabel: '数据看板', icon: BarChart3 },
]

// 「预警」标签内部用分段控件切换：事件记录 / 报警设置
const alertSections = [
  { id: 'records', label: '事件记录' },
  { id: 'settings', label: '报警设置' },
]

const DEFAULT_ALARM_SETTINGS = {
  sound: true,
  voice: true,
  vibrate: true,
  autoTrigger: true,
  escalateSec: 30,
  highThreshold: DEFAULT_THRESHOLDS.high,
  mediumThreshold: DEFAULT_THRESHOLDS.medium,
}

const SPOT_LABELS = { A: 'A 楼梯口', C: '走廊中段', B: 'B 楼梯口' }

function loadStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

const defaultCameras = [
  { id: 'thermal-board-sim', name: '模拟热成像板', location: '实验室 P11', type: 'sensor', url: 'sensor://esp32-sim', public: true },
  { id: 'demo-live', name: '热感监控演示', location: '三楼东侧走廊', type: 'demo', url: DEMO_LIVE, public: true },
]

function encodeCamera(camera) {
  const bytes = new TextEncoder().encode(JSON.stringify(camera))
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCamera(value) {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

function initialActiveTab() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('camera') || params.get('view') === 'camera') return 'camera'
  } catch {}
  return 'home'
}

function initialCameraState() {
  let base = defaultCameras
  try {
    const saved = JSON.parse(localStorage.getItem('thermalGuardCameras') || 'null')
    if (Array.isArray(saved) && saved.length) base = saved
    if (!base.some((camera) => camera.type === 'sensor')) base = [defaultCameras[0], ...base]
  } catch {}
  const shared = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('camera') : null
  const parsed = shared ? decodeCamera(shared) : null
  return parsed?.public && parsed?.url ? [{ ...parsed, id: `shared-${parsed.id || Date.now()}` }, ...base] : base
}

const initialDevices = [
  { id: 'demo-lab', name: '实验室 ESP32', location: '澳门科技大学 P11', url: 'wss://192.168.4.1:81/' },
]

const sampleAlerts = [
  { id: 'sample-1', time: '2026-09-13 19:42:18', risk: 'high', zone: '三楼东侧走廊', temp: 86.4, hotspots: 3 },
  { id: 'sample-2', time: '2026-09-13 16:08:42', risk: 'medium', zone: '仓库北门配电区', temp: 52.8, hotspots: 1 },
  { id: 'sample-3', time: '2026-09-12 21:15:06', risk: 'low', zone: '一楼设备间', temp: 38.6, hotspots: 0 },
]

const trendValues = [42, 46, 44, 51, 48, 55, 59, 57, 63, 68, 66, 72]
const barValues = [72, 58, 44, 31, 26]

function riskTitle(risk) {
  return risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险'
}

function riskAdvice(risk) {
  return risk === 'high' ? '立即疏散' : risk === 'medium' ? '现场核查' : '持续观察'
}

function riskColor(risk) {
  return risk === 'high' ? '#ef4444' : risk === 'medium' ? '#f59e0b' : '#22c55e'
}

function ConnectionBadge({ state }) {
  const text = state === 'connected' ? '设备在线' : state === 'connecting' ? '连接中' : state === 'failed' ? '连接失败' : '模拟运行'
  return <span className={`connection-badge state-${state}`} title={text}><i /><span className="conn-text">{text}</span></span>
}

function RiskBadge({ risk, compact = false }) {
  return <span className={`risk-badge risk-${risk} ${compact ? 'compact' : ''}`}><i />{riskTitle(risk)}</span>
}

function DeviceSheet({ devices, activeDevice, connection, error, onClose, onConnect, onDisconnect, onSave, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ name: '', location: '', url: '', floor: 4 })
  const editingDevice = editing && typeof editing === 'object' ? editing : null
  const valid = form.name.trim() && /^wss?:\/\//i.test(form.url.trim())

  const openForm = (device) => {
    setEditing(device || 'new')
    setForm(device ? { name: device.name, location: device.location, url: device.url, floor: device.floor || 4 } : { name: '', location: '', url: '', floor: 4 })
  }

  if (editing) {
    return (
      <div className="sheet-backdrop" onClick={onClose}>
        <section className="device-sheet" onClick={(event) => event.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-head">
            <div><span>硬件设置</span><strong>{editingDevice ? '编辑设备' : '添加设备'}</strong></div>
            <button type="button" onClick={() => setEditing(null)}><ArrowLeft size={18} /></button>
          </div>
          <label>设备名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：实验楼 ESP32" /></label>
          <label>设备位置<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="例如：三楼东侧走廊" /></label>
          <label>
            安装楼层
            <select value={form.floor} onChange={(e) => setForm({ ...form, floor: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 楼</option>)}
            </select>
          </label>
          <label>WebSocket 地址<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="wss://设备地址:81/" inputMode="url" autoCapitalize="none" /></label>
          <div className="sheet-tip"><Info size={14} />手机网页使用 HTTPS 时通常只能连接 wss:// 地址；普通 ws:// 可在 Mac App 中使用。</div>
          <button className="sheet-save" type="button" disabled={!valid} onClick={() => { onSave(editingDevice?.id, { name: form.name.trim(), location: form.location.trim(), url: form.url.trim(), floor: form.floor }); setEditing(null) }}><Save size={16} />保存设备</button>
        </section>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="device-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div><span>硬件设置</span><strong>设备管理</strong></div>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="simulator-row"><span><Cpu size={19} /></span><div><strong>内置模拟热像仪</strong><small>无需硬件即可演示</small></div><button type="button" onClick={onDisconnect}>运行</button></div>
        <div className="sheet-section-title"><strong>已添加设备</strong><button type="button" onClick={() => openForm(null)}><Plus size={15} />添加</button></div>
        {devices.map((device) => {
          const active = activeDevice?.id === device.id
          return (
            <article className={`device-row ${active ? 'active' : ''}`} key={device.id}>
              <div className="device-row-main"><span><Wifi size={18} /></span><div><strong>{device.name}</strong><small>{device.location || '未设置位置'}</small><code>{device.url}</code></div><em>{active && connection === 'connected' ? '在线' : '离线'}</em></div>
              <div className="device-row-actions">
                <button type="button" onClick={() => active && connection === 'connected' ? onDisconnect() : onConnect(device)}>{active && connection === 'connected' ? <WifiOff size={14} /> : <Link2 size={14} />}{active && connection === 'connected' ? '断开' : '连接'}</button>
                <button type="button" onClick={() => openForm(device)}><Edit3 size={14} />编辑</button>
                <button type="button" onClick={() => onDelete(device.id)}><Trash2 size={14} />删除</button>
              </div>
            </article>
          )
        })}
        {error && <div className="device-error"><AlertTriangle size={15} />{error}</div>}
        <div className="sheet-tip protocol-tip"><Database size={14} />设备每帧发送 width、height、max_temp、risk、temperatures 和 hotspots 字段。</div>
      </section>
    </div>
  )
}

function HeatPreview({ image, result, detected, detecting }) {
  return (
    <div className={`heat-preview ${image ? 'has-image' : ''}`}>
      {image ? (
        <>
          <img src={image} alt="热成像检测预览" />
          <div className="heat-grid" />
          <div className="heat-scan" />
          <div className="preview-tag"><span />热成像输入</div>
          {detected && result.hotspots.slice(0, 3).map((spot, index) => (
            <div className="heat-box" key={index} style={{ left: `${spot.x}%`, top: `${spot.y}%`, width: `${spot.w}%`, height: `${spot.h}%`, '--delay': `${index * 160}ms` }}>
              <span>热区 {String(index + 1).padStart(2, '0')}</span><b>{spot.temp.toFixed(1)}°C</b>
            </div>
          ))}
        </>
      ) : (
        <div className="upload-empty"><span><ImageIcon size={33} /></span><strong>等待热成像图片</strong><p>拍摄或从相册选择图片后开始检测</p></div>
      )}
    </div>
  )
}

function RiskLevelCard({ risk, active }) {
  const title = riskTitle(risk)
  const advice = riskAdvice(risk)
  const Icon = risk === 'high' ? ShieldAlert : risk === 'medium' ? AlertTriangle : ShieldCheck
  return (
    <article className={`level-card level-${risk} ${active ? 'active' : ''}`}>
      <span><Icon size={18} /></span><div><strong>{title}</strong><small>{advice}</small></div>{active && <CheckCircle2 size={17} />}
    </article>
  )
}

function HomePage({ inputCameraRef, inputGalleryRef, image, fileName, detecting, progress, detected, result, onImage, onSample, onReset, onDetect }) {
  return (
    <div className="mobile-page home-page">
      <header className="home-header">
        <div className="guard-pill"><Sparkles size={13} />AI 火警网警</div>
        <h1>AI热感火警风险检测</h1>
        <p>超早期温度预警 · 多维度智能判断</p>
      </header>

      <section className="detect-card">
        <div className="card-head"><div><strong>热成像图片检测</strong><small>火焰出现前捕捉异常温升</small></div><button type="button" onClick={onSample}>载入示例</button></div>
        <HeatPreview image={image} result={result} detected={detected} detecting={detecting} />
        <div className="capture-actions">
          <button type="button" onClick={() => inputCameraRef.current?.click()}><Camera size={16} />拍摄热成像图</button>
          <button type="button" onClick={() => inputGalleryRef.current?.click()}><Upload size={16} />上传图片</button>
        </div>
        <input ref={inputCameraRef} type="file" accept="image/*" capture="environment" onChange={(e) => onImage(e.target.files?.[0])} />
        <input ref={inputGalleryRef} type="file" accept="image/*" onChange={(e) => onImage(e.target.files?.[0])} />
        <div className="image-meta"><span>{fileName || '尚未选择图片'}</span>{image && <button type="button" onClick={onReset}><RotateCcw size={13} />重置</button>}</div>
        <button className="detect-button" type="button" disabled={!image || detecting} onClick={onDetect}>
          {detecting ? <LoaderCircle className="spin" size={18} /> : <ScanLine size={18} />}{detecting ? 'AI 正在检测' : '开始 AI 检测'}
        </button>
        {detecting && <div className="progress-wrap"><div><span style={{ width: `${progress}%` }} /></div><small>{progress}% · 温度轮廓与扩散梯度分析中</small></div>}
      </section>

      {detected && (
        <section className="result-reveal">
          <div className="result-title"><div><span>AI检测结果</span><strong>{riskTitle(result.risk)}</strong></div><RiskBadge risk={result.risk} /></div>
          <div className="level-grid">
            <RiskLevelCard risk="low" active={result.risk === 'low'} />
            <RiskLevelCard risk="medium" active={result.risk === 'medium'} />
            <RiskLevelCard risk="high" active={result.risk === 'high'} />
          </div>
          <div className="detail-grid">
            <div><MapPin size={17} /><span>高温区域</span><strong>{result.hotspots.length} 处</strong></div>
            <div><Thermometer size={17} /><span>最高温度</span><strong>{result.maxTemp.toFixed(1)}°C</strong></div>
            <div>
              <Crosshair size={17} />
              <span>区域坐标</span>
              <strong>{result.hotspots.length ? `X ${Math.round(result.hotspots[0].x)}% / Y ${Math.round(result.hotspots[0].y)}%` : '未检出'}</strong>
            </div>
          </div>
          <div className="ai-explain"><span><Cpu size={17} /></span><div><strong>AI判断说明</strong><p>基于温度轮廓、扩散梯度、持续特征多维度综合分析，区分正常热源与火灾隐患，有效降低误报率。</p></div></div>
          <div className="early-warning"><Zap size={15} />可在明火、烟雾出现前识别温度异常，实现灾前预警。</div>
        </section>
      )}
    </div>
  )
}

function AlertsPage({ alerts, onToast }) {
  const [riskFilter, setRiskFilter] = useState('全部')
  const [timeFilter, setTimeFilter] = useState('全部时间')
  const [selected, setSelected] = useState(null)
  const filtered = alerts.filter((item) => riskFilter === '全部' || item.risk === (riskFilter === '高风险' ? 'high' : riskFilter === '中风险' ? 'medium' : 'low'))

  if (selected) {
    return (
      <div className="mobile-page">
        <button className="back-button" type="button" onClick={() => setSelected(null)}><ArrowLeft size={16} />返回记录</button>
        <section className="alert-detail-card">
          <div className="alert-detail-head"><RiskBadge risk={selected.risk} /><span>{selected.time}</span></div>
          <img src={DEMO_THERMAL} alt="历史热成像记录" />
          <h2>{selected.zone}</h2>
          <div className="detail-grid alert-detail-grid"><div><Thermometer size={16} /><span>最高温度</span><strong>{selected.temp.toFixed(1)}°C</strong></div><div><MapPin size={16} /><span>高温区域</span><strong>{selected.hotspots} 处</strong></div></div>
          <div className="advice-box"><ShieldAlert size={18} /><div><strong>{riskAdvice(selected.risk)}</strong><p>{selected.risk === 'high' ? '立即核查电源、设备与周边可燃物，确认疏散通道畅通。' : selected.risk === 'medium' ? '安排人员现场检查设备运行状态，持续观察温升趋势。' : '当前无明显异常，保持规律巡检。'}</p></div></div>
        </section>
      </div>
    )
  }

  return (
    <div className="mobile-page">
      <header className="page-heading"><span>预警记录</span><h1>检测日志</h1><p>自动留存检测日志，支持事后回溯分析起火原因与蔓延过程</p></header>
      {alerts.length > 0 && (
        <div className="record-toolbar">
          <ReportButton
            className="record-export"
            label="导出处置报告（PDF）"
            onDone={(state) => onToast?.(state === 'saved' ? '处置报告已保存为 PDF 文件' : '已在新标签页打开报告，可按 ⌘P 存为 PDF')}
            build={() => {
              const worst = alerts.some((item) => item.risk === 'high')
                ? 'high'
                : alerts.some((item) => item.risk === 'medium') ? 'medium' : 'low'
              const maxTemp = Math.max(...alerts.map((item) => Number(item.temp) || 0))
              return {
                system: '热感哨兵 · 系统端',
                generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
                location: '澳门科技大学校园数字孪生 · 检测日志汇总',
                risk: worst,
                riskLabel: riskTitle(worst),
                riskIndex: Math.min(99, Math.round(maxTemp)),
                maxTemp,
                hotspotCount: alerts.reduce((sum, item) => sum + (item.hotspots || 0), 0),
                recommendedExit: '1 楼大堂正门',
                notes: `共 ${alerts.length} 条记录：${alerts.slice(0, 3).map((item) => `${item.zone}（${item.time}，${item.temp.toFixed(1)}°C）`).join('；')}。`,
              }
            }}
          />
          <span className="record-toolbar-hint">导出后在新标签页按 ⌘P / Ctrl+P 可存成 PDF 文件</span>
        </div>
      )}
      <div className="filter-row">{['全部', '高风险', '中风险', '低风险'].map((item) => <button type="button" className={riskFilter === item ? 'active' : ''} key={item} onClick={() => setRiskFilter(item)}>{item}</button>)}</div>
      <div className="filter-row secondary">{['全部时间', '今天', '最近7天'].map((item) => <button type="button" className={timeFilter === item ? 'active' : ''} key={item} onClick={() => setTimeFilter(item)}>{item}</button>)}</div>
      {filtered.map((item) => (
        <button className={`alert-list-card alert-${item.risk}`} type="button" key={item.id} onClick={() => setSelected(item)}>
          <span className="alert-icon"><AlertTriangle size={18} /></span>
          <div><strong>{item.zone}</strong><small>{item.time}</small><em>{item.hotspots} 个高温区域 · 最高 {item.temp.toFixed(1)}°C</em></div>
          <RiskBadge risk={item.risk} compact /><ChevronRight size={16} />
        </button>
      ))}
      {!filtered.length && <div className="empty-state"><ShieldCheck size={38} /><strong>没有符合条件的记录</strong><p>调整时间或风险等级筛选后再查看。</p></div>}
    </div>
  )
}

function LineChart() {
  const width = 320
  const height = 130
  const max = Math.max(...trendValues)
  const min = Math.min(...trendValues)
  const points = trendValues.map((value, index) => {
    const x = 10 + (index / (trendValues.length - 1)) * 300
    const y = 112 - ((value - min) / Math.max(max - min, 1)) * 92
    return [x, y]
  })
  const line = points.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `10,118 ${line} 310,118`
  return <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#38bdf8" stopOpacity=".34" /><stop offset="1" stopColor="#38bdf8" stopOpacity="0" /></linearGradient></defs><polygon points={area} fill="url(#chart-fill)" /><polyline points={line} fill="none" stroke="#38bdf8" strokeWidth="3" vectorEffect="non-scaling-stroke" />{points.map(([x, y], index) => <circle key={index} cx={x} cy={y} r="2.5" fill="#07101e" stroke="#38bdf8" strokeWidth="2" />)}</svg>
}


function directionLabel(degree) {
  const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return labels[Math.round(((degree % 360) + 360) % 360 / 45) % 8]
}

function shortestTurn(target, heading) {
  return ((target - heading + 540) % 360) - 180
}

function EscapeCompass({ risk, maxTemp }) {
  const exitBearing = risk === 'high' ? 18 : 42
  const [heading, setHeading] = useState(24)
  const [tracking, setTracking] = useState(false)
  const [permission, setPermission] = useState('prompt')

  useEffect(() => {
    if (!tracking) return undefined
    const handler = (event) => {
      const raw = Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading : Number(event.alpha)
      if (Number.isFinite(raw)) setHeading((raw + 360) % 360)
    }
    window.addEventListener('deviceorientationabsolute', handler, true)
    window.addEventListener('deviceorientation', handler, true)
    return () => {
      window.removeEventListener('deviceorientationabsolute', handler, true)
      window.removeEventListener('deviceorientation', handler, true)
    }
  }, [tracking])

  const enableCompass = async () => {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const result = await DeviceOrientationEvent.requestPermission()
        setPermission(result)
        if (result !== 'granted') return
      } else {
        setPermission('granted')
      }
      setTracking(true)
    } catch {
      setPermission('denied')
    }
  }

  const turn = shortestTurn(exitBearing, heading)
  const turnText = Math.abs(turn) < 15
    ? '保持当前方向直行'
    : turn > 0
      ? `向右转 ${Math.round(Math.abs(turn))}° 后前进`
      : `向左转 ${Math.round(Math.abs(turn))}° 后前进`

  return (
    <section className="mobile-card escape-card">
      <div className="card-head">
        <div><strong>指南针疏散导航</strong><small>结合风险等级与安全出口方向动态引导</small></div>
        <Compass size={19} />
      </div>
      <div className="compass-layout">
        <div className="compass-dial" style={{ '--heading': `${-heading}deg`, '--turn': `${turn}deg` }}>
          <span className="compass-n">N</span>
          <span className="compass-e">E</span>
          <span className="compass-s">S</span>
          <span className="compass-w">W</span>
          <i className="compass-ring" />
          <b className="compass-arrow"><Navigation size={20} /></b>
          <em />
        </div>
        <div className="route-summary">
          <span className={`route-risk route-${risk}`}>{riskTitle(risk)} · {risk === 'high' ? '建议立即撤离' : '建议预防性撤离'}</span>
          <strong>{directionLabel(exitBearing)}向安全出口</strong>
          <p>{turnText}</p>
          <div className="route-stats"><span><Route size={12} />86 米</span><span><LocateFixed size={12} />约 42 秒</span></div>
        </div>
      </div>
      <div className="escape-steps">
        <span><i>01</i>离开当前高温区域</span>
        <span><i>02</i>前往东侧安全楼梯</span>
        <span><i>03</i>低姿通过烟区</span>
        <span><i>04</i>到达一楼集合点</span>
      </div>
      <div className="compass-status">
        <span><i className={tracking ? 'online' : ''} />{tracking ? `实时方向 ${Math.round(heading)}°` : permission === 'denied' ? '未授权，正在使用模拟方向' : '待开启手机指南针'}</span>
        <b>最高温 {Number(maxTemp || 0).toFixed(1)}°C</b>
      </div>
      {!tracking && <button type="button" className="compass-enable" onClick={enableCompass}><Compass size={15} />开启指南针并开始引导</button>}
    </section>
  )
}

function Thermal3DScene({ frame, camera }) {
  const fallbackHotspots = [
    { x: 28, y: 24, temp: frame?.maxTemp || 72 },
    { x: 64, y: 30, temp: (frame?.maxTemp || 72) - 13 },
  ]
  const hotspots = frame?.hotspots?.length ? frame.hotspots : fallbackHotspots
  const maxTemp = Number(frame?.maxTemp || 0)

  return (
    <div className="thermal-3d-view">
      <div className="scene-vignette" />
      <div className="scene-room">
        <div className="scene-back-wall">
          <span /><span /><span /><span /><span /><span />
        </div>
        <div className="scene-left-wall" />
        <div className="scene-right-wall" />
        <div className="scene-floor">
          <i className="scene-route-line" />
        </div>
        <div className="scene-sensor">
          <RadioTower size={15} />
          <span>32×24</span>
        </div>
        {hotspots.slice(0, 3).map((spot, index) => (
          <div
            className={`scene-hotspot scene-hotspot-${index + 1}`}
            key={`${spot.x}-${spot.y}-${index}`}
            style={{
              left: `${17 + (Number(spot.x || 0) / 100) * 56}%`,
              top: `${30 + (Number(spot.y || 0) / 100) * 27}%`,
              '--spot-color': Number(spot.temp || maxTemp) >= 65 ? '#ff3b30' : '#ff9d2e',
            }}
          >
            <i />
            <span>{Number(spot.temp || maxTemp).toFixed(1)}°</span>
          </div>
        ))}
        <div className="scene-scan-plane" />
      </div>
      <div className="scene-hud scene-hud-top">
        <span><Rotate3D size={13} />3D 热感重建</span>
        <b>{frame?.width || 32}×{frame?.height || 24} · 3.1 帧/秒</b>
      </div>
      <div className="scene-hud scene-hud-bottom">
        <span><i />{camera?.name || '热成像板'} · {camera?.location || '实时联动'}</span>
        <b>最高 {maxTemp.toFixed(1)}°C</b>
      </div>
      <div className="scene-axis"><span>X</span><span>Y</span><span>Z</span></div>
    </div>
  )
}

function LivePlayer({ camera, frame, viewMode }) {
  const videoRef = useRef(null)
  const playerRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(() => new Date().toLocaleString('zh-CN', { hour12: false }))

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date().toLocaleString('zh-CN', { hour12: false })), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!camera || viewMode === 'thermal3d' || camera.type === 'sensor' || camera.type === 'demo' || camera.type === 'mjpeg') return undefined
    const video = videoRef.current
    if (!video) return undefined
    let hls
    let cancelled = false
    const start = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = camera.url
        video.play().catch(() => {})
        return
      }
      const { default: Hls } = await import('hls.js')
      if (cancelled || !videoRef.current || !Hls.isSupported()) return
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true })
      hls.loadSource(camera.url)
      hls.attachMedia(videoRef.current)
      hls.on(Hls.Events.MANIFEST_PARSED, () => videoRef.current?.play().catch(() => {}))
    }
    start()
    return () => {
      cancelled = true
      hls?.destroy()
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [camera, viewMode])

  const enterFullscreen = () => {
    const element = playerRef.current
    if (!element) return
    if (document.fullscreenElement) document.exitFullscreen?.()
    else element.requestFullscreen?.()
  }

  return (
    <div className="live-player" ref={playerRef}>
      {viewMode === 'thermal3d' || camera.type === 'sensor' ? <Thermal3DScene frame={frame} camera={camera} /> : null}
      {viewMode !== 'thermal3d' && camera.type === 'demo' && <img src={camera.url} alt={`${camera.name}演示监控`} />}
      {viewMode !== 'thermal3d' && camera.type === 'mjpeg' && <img src={camera.url} alt={`${camera.name}实时监控`} />}
      {viewMode !== 'thermal3d' && camera.type === 'hls' && <video ref={videoRef} controls muted autoPlay playsInline />}
      <div className="live-grid" />
      {camera.type === 'demo' && <div className="live-scan" />}
      <div className="live-status"><i />{viewMode === 'thermal3d' || camera.type === 'sensor' ? '热感板联动' : camera.type === 'demo' ? '公开演示流' : camera.public ? '公开监控' : '本机监控'}</div>
      {viewMode !== 'thermal3d' && camera.type !== 'sensor' && <div className="live-camera-name"><Video size={14} /><span>{camera.name}</span><small>{camera.location || '未设置位置'}</small></div>}
      <button className="fullscreen-button" type="button" onClick={enterFullscreen}><Maximize2 size={16} /></button>
      <div className="live-time">{currentTime}</div>
    </div>
  )
}

function CameraSheet({ editing, onClose, onSave }) {
  const [name, setName] = useState(editing?.name || '')
  const [location, setLocation] = useState(editing?.location || '')
  const [type, setType] = useState(editing?.type || 'hls')
  const [url, setUrl] = useState(editing?.url || '')
  const [isPublic, setIsPublic] = useState(Boolean(editing?.public))
  const valid = name.trim() && (type === 'demo' || type === 'sensor' || /^https?:\/\//i.test(url.trim()))

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="device-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head"><div><span>监控联动</span><strong>{editing ? '编辑监控' : '添加监控'}</strong></div><button type="button" onClick={onClose}><X size={18} /></button></div>
        <label>监控名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：三楼东侧走廊" /></label>
        <label>安装位置<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例如：消防通道入口" /></label>
        <label>监控类型<select value={type} onChange={(e) => { setType(e.target.value); if (e.target.value === 'demo') setUrl(DEMO_LIVE); if (e.target.value === 'sensor') setUrl('sensor://esp32-sim') }}><option value="hls">HLS 实时流</option><option value="mjpeg">MJPEG 实时流</option><option value="sensor">3D 热感模拟板</option><option value="demo">内置公开演示流</option></select></label>
        <label>监控地址<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/live.m3u8" inputMode="url" autoCapitalize="none" disabled={type === 'demo' || type === 'sensor'} /></label>
        <label className="public-toggle"><input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /><span><strong>允许通过分享链接公开查看</strong><small>请勿公开包含人员、住宅、门禁或消防设施细节的画面</small></span></label>
        <div className="sheet-tip"><Info size={14} />RTSP 地址不能被手机浏览器直接播放，需要海康、大华 NVR 或媒体网关转换为 HLS/WebRTC。</div>
        <button className="sheet-save" type="button" disabled={!valid} onClick={() => onSave({ name: name.trim(), location: location.trim(), type, url: type === 'demo' ? DEMO_LIVE : type === 'sensor' ? 'sensor://esp32-sim' : url.trim(), public: isPublic })}><Save size={16} />保存监控</button>
      </section>
    </div>
  )
}

function CameraPage({ cameras, selectedCamera, onSelect, onAdd, onEdit, onDelete, canShare, onShare, frame, connection }) {
  const [viewMode, setViewMode] = useState(selectedCamera?.type === 'sensor' ? 'thermal3d' : 'camera')

  useEffect(() => {
    setViewMode(selectedCamera?.type === 'sensor' ? 'thermal3d' : 'camera')
  }, [selectedCamera?.id, selectedCamera?.type])

  const canSwitchView = selectedCamera?.type !== 'sensor'

  return (
    <div className="mobile-page camera-page">
      <header className="page-heading camera-heading"><span>现场监控</span><h1>热成像与监控联动</h1><p>实景监控、3D 热感重建与疏散导航在同一画面联动</p></header>
      {canSwitchView && <div className="view-switcher">
        <button type="button" className={viewMode === 'camera' ? 'active' : ''} onClick={() => setViewMode('camera')}><Video size={14} />实景监控</button>
        <button type="button" className={viewMode === 'thermal3d' ? 'active' : ''} onClick={() => setViewMode('thermal3d')}><Rotate3D size={14} />3D 热感视图</button>
      </div>}
      <LivePlayer camera={selectedCamera} frame={frame} viewMode={viewMode} />
      <div className="camera-actions">
        <button type="button" className={canShare ? '' : 'disabled'} onClick={() => canShare && onShare(selectedCamera)}><Copy size={15} />分享当前监控</button>
        <button type="button" onClick={onAdd}><Plus size={15} />添加监控</button>
      </div>

      <section className="mobile-card thermal-link-card">
        <div className="card-head"><div><strong>模拟热成像板联动</strong><small>ESP32 / MLX90640 数据格式演示</small></div><RadioTower size={18} /></div>
        <div className="thermal-link-status">
          <span><i className={connection === 'connected' ? 'online' : ''} />{connection === 'connected' ? '真实硬件在线' : '模拟器数据流运行中'}</span>
          <b>{frame?.source || '内置模拟热像仪'}</b>
        </div>
        <div className="thermal-link-metrics">
          <div><span>矩阵</span><strong>{frame?.width || 32}×{frame?.height || 24}</strong></div>
          <div><span>最高温</span><strong>{Number(frame?.maxTemp || 0).toFixed(1)}°C</strong></div>
          <div><span>热区</span><strong>{frame?.hotspots?.length || 0} 处</strong></div>
        </div>
        <p className="thermal-link-note"><Box size={13} />手机端可接入 HLS、MJPEG，或直接接收 width、height、max_temp、temperatures、hotspots 格式的热感板数据。</p>
      </section>

      <EscapeCompass risk={frame?.risk || 'low'} maxTemp={frame?.maxTemp} />

      <div className="section-title"><strong>监控列表</strong><span>{cameras.length} 路</span></div>
      <div className="camera-grid">
        {cameras.map((camera) => {
          const active = selectedCamera?.id === camera.id
          return (
          <article className={`camera-card ${active ? 'active' : ''}`} key={camera.id} onClick={() => onSelect(camera)}>
            <div className={`camera-thumb ${camera.type === 'sensor' ? 'thermal-thumb' : ''}`}>
              {camera.type === 'sensor' ? <><Rotate3D size={27} /><span>{camera.public ? '公开' : '授权'}</span></> : camera.type === 'demo' || camera.type === 'mjpeg' ? <><img src={camera.url} alt="" /><span>{camera.public ? '公开' : '授权'}</span></> : <><Video size={25} /><span>{camera.public ? '公开' : '授权'}</span></>}
            </div>
            <div className="camera-info"><strong>{camera.name}</strong><small>{camera.location || '未设置位置'}</small><em>{camera.type === 'sensor' ? '3D热感板' : camera.type === 'demo' ? '演示流' : camera.type.toUpperCase()}</em></div>
            <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(camera) }}><Edit3 size={14} /></button>
            <button type="button" onClick={(event) => { event.stopPropagation(); onDelete(camera.id) }}><Trash2 size={14} /></button>
          </article>
        )})}
      </div>
      <div className="monitor-note"><Globe2 size={16} /><p>公开流适合无隐私的演示区域。真实监控建议通过账号授权、临时签名地址或受控网关接入，不建议直接暴露 NVR 地址或长期公开。</p></div>
    </div>
  )
}

function DashboardPage({ onOpenAbout }) {
  const stats = [
    ['累计检测图像', '12,846', '张', '+18.6%', ImageIcon, 'blue'],
    ['预警总次数', '1,329', '次', '+12.4%', BellRing, 'orange'],
    ['中高风险占比', '23.8', '%', '-2.1%', Gauge, 'red'],
    ['平均响应时间', '1.8', '秒', '较上月 -0.4s', Clock3, 'green'],
  ]
  return (
    <div className="mobile-page">
      <header className="page-heading"><span>数据看板</span><h1>风险数据洞察</h1><p>用于消防安全管理数据分析与隐患排查优化</p></header>
      <div className="dashboard-grid">{stats.map(([label, value, unit, change, Icon, tone]) => <article className={`dashboard-stat tone-${tone}`} key={label}><span><Icon size={16} /></span><p>{label}</p><strong>{value}<small>{unit}</small></strong><em>{change}</em></article>)}</div>
      <section className="mobile-card chart-card"><div className="card-head"><div><strong>风险趋势</strong><small>近30日最高温度预警指数</small></div><TrendingUp size={18} /></div><LineChart /></section>
      <section className="mobile-card chart-card"><div className="card-head"><div><strong>隐患类型分布</strong><small>高频隐患分类统计</small></div><BarChart3 size={18} /></div><div className="bar-chart">{[['电气过热', 72], ['设备异常', 58], ['环境温升', 44], ['线路老化', 31], ['其他', 26]].map(([label, value], index) => <div className="bar-row" key={label}><span>{label}</span><div><i style={{ width: `${value}%`, '--bar-delay': `${index * 90}ms` }} /></div><b>{value}</b></div>)}</div></section>
      <div className="dashboard-note"><Activity size={16} />数据用于隐患识别、巡检优先级排序和风险治理优化。</div>
      {onOpenAbout && (
        <button className="disclosure-row" type="button" onClick={onOpenAbout}>
          <span><Layers3 size={18} /></span>
          <div><strong>关于项目</strong><small>技术原理、五大核心创新与适用场景</small></div>
          <ChevronRight size={17} />
        </button>
      )}
    </div>
  )
}

function AboutPage({ onBack }) {
  return (
    <div className="mobile-page">
      {onBack && <button className="back-button" type="button" onClick={onBack}><ArrowLeft size={16} />返回看板</button>}
      <header className="page-heading"><span>关于项目</span><h1>让AI成为火警监测网警</h1><p>热成像 + 计算机视觉，让隐患在灾害发生前被看见</p></header>
      <section className="mobile-card principle-card"><div className="card-head"><div><strong>技术原理</strong><small>多模态融合识别</small></div><Cpu size={19} /></div><div className="principle-flow"><div><ScanLine size={20} /><strong>YOLO检测</strong><span>火焰与烟雾目标</span></div><ArrowRight size={16} /><div><Thermometer size={20} /><strong>温度融合</strong><span>热区轮廓与梯度</span></div><ArrowRight size={16} /><div><ShieldAlert size={20} /><strong>风险判断</strong><span>灾前分级预警</span></div></div></section>
      <section className="mobile-card innovation-card"><div className="card-head"><div><strong>六大核心创新</strong><small>AI火警网警的优势</small></div><Sparkles size={18} /></div>{[['灾前预警', '在明火和烟雾出现前识别温度异常'], ['精准定位', '红橙热区标注高温隐患位置'], ['多级研判', '温度轮廓、扩散梯度、持续特征综合分析'], ['低误报率', '区分人员、设备和正常热源'], ['3D热感重建', '将热成像板数据映射到空间热源场景'], ['智能疏散导航', '指南针结合安全出口动态引导撤离']].map(([title, text], index) => <div className="innovation-row" key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{title}</strong><p>{text}</p></div></div>)}</section>
      <section className="mobile-card advantage-card"><div><ShieldCheck size={19} /><strong>复杂场景适配</strong></div><p>适配老旧楼宇、仓库、配电房和人员密集楼道，无需大规模重新布线，硬件成本可控，适合民用普及。</p></section>
      <InspectionPanel />
      <HazardReport />
      <div className="disclaimer"><ShieldAlert size={17} /><p>本系统为科研演示原型，不替代专业消防检测设备与灭火系统。</p></div>
    </div>
  )
}

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState(initialActiveTab)
  const [showDevices, setShowDevices] = useState(false)
  const [showAiSheet, setShowAiSheet] = useState(false)
  const [arOpen, setArOpen] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const [frameHistory, setFrameHistory] = useState([])
  const [rescueBrief, setRescueBrief] = useState(null)
  const [showLinkSheet, setShowLinkSheet] = useState(false)
  const [peerEvents, setPeerEvents] = useState([])
  // 最近一条"还没处置"的用户端上报（系统端横幅用它提醒指挥人员）
  const [peerReport, setPeerReport] = useState(null)
  const firePublishedRef = useRef(false)
  const [phase, setPhase] = useState(0)
  const [frame, setFrame] = useState(() => createFrame())
  const [image, setImage] = useState('')
  const [fileName, setFileName] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [detected, setDetected] = useState(false)
  const [result, setResult] = useState(createFrame())
  const [alerts, setAlerts] = useState(() => loadStored('thermalGuardAlerts', sampleAlerts))
  const [devices, setDevices] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem('thermalGuardDevices') || 'null'); return Array.isArray(saved) && saved.length ? saved : initialDevices } catch { return initialDevices }
  })
  const [activeDevice, setActiveDevice] = useState(null)
  const [connection, setConnection] = useState('simulator')
  const [error, setError] = useState('')
  const [cameras, setCameras] = useState(initialCameraState)
  const [selectedCameraId, setSelectedCameraId] = useState(() => initialCameraState()[0].id)
  const [cameraSheet, setCameraSheet] = useState(null)
  const [toast, setToast] = useState('')
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_ALARM_SETTINGS, ...loadStored('thermalGuardAlarmSettings', {}) }))
  const [alertSection, setAlertSection] = useState('records')
  const [dashView, setDashView] = useState('dashboard')
  const [mapView, setMapView] = useState('campus')
  const [campusPick, setCampusPick] = useState(null)
  const [crowd, setCrowd] = useState(() => createCrowdState())
  const [crowdHistory, setCrowdHistory] = useState([])
  const [demoStep, setDemoStep] = useState(0)
  const [alarm, setAlarm] = useState(null)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [fire, setFire] = useState(null)
  const [position, setPosition] = useState({ floor: 4, spot: 'C' })
  const [blockedNodes, setBlockedNodes] = useState([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [audioReady, setAudioReady] = useState(() => isAudioUnlocked())
  const [notice, setNotice] = useState(null)
  const [scrolled, setScrolled] = useState(false)
  const timerRef = useRef(null)
  const socketRef = useRef(null)
  const inputCameraRef = useRef(null)
  const inputGalleryRef = useRef(null)
  const armedRef = useRef(true)

  useEffect(() => {
    localStorage.setItem('thermalGuardDevices', JSON.stringify(devices))
  }, [devices])

  useEffect(() => {
    localStorage.setItem('thermalGuardAlerts', JSON.stringify(alerts.slice(0, 60)))
  }, [alerts])

  useEffect(() => {
    localStorage.setItem('thermalGuardAlarmSettings', JSON.stringify(settings))
  }, [settings])

  // 报警或火情进行时开启 1 秒心跳，用于计时与路线重算
  useEffect(() => {
    if (!alarm && !fire) return undefined
    setNowMs(Date.now())
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [alarm, fire])

  // 阶段一需要"温升速率"，这里留最近若干帧的最高温做趋势（真实设备由采样帧提供）
  useEffect(() => {
    if (!Number.isFinite(result?.maxTemp)) return
    setFrameHistory((current) => [...current, { at: Date.now(), maxTemp: result.maxTemp }].slice(-12))
  }, [result?.maxTemp, result?.timestamp])


  // 把火情同步给用户端：同一浏览器里打开 user-app.html 的标签页会收到 storage 事件，
  // 于是「系统端触发报警 → 用户端表盘立刻转向撤离方向」可以在一台设备上演示。
  useEffect(() => {
    try {
      if (fire) {
        localStorage.setItem('thermalGuardFire', JSON.stringify({
          nodeId: fire.nodeId,
          floor: fire.floor,
          startedAt: fire.startedAt,
          mode: fire.mode,
          // 多火源：系统端判定了多个起火节点时一并同步给用户端
          ...(Array.isArray(fire.nodes) && fire.nodes.length > 1 ? { nodes: fire.nodes } : {}),
        }))
      } else {
        localStorage.removeItem('thermalGuardFire')
      }
    } catch {
      /* 隐私模式下不可写，忽略 */
    }

    // 同时走事件总线：同机同浏览器直接互通；用本地服务器打开时还会经 /sync 中继到别的设备
    const bus = sharedEventBus()
    bus.start()
    if (fire) {
      firePublishedRef.current = true
      bus.publish(createEvent('fire', {
        nodeId: fire.nodeId,
        floor: fire.floor ?? position.floor,
        startedAt: fire.startedAt,
        mode: fire.mode,
        ...(Array.isArray(fire.nodes) && fire.nodes.length > 1 ? { nodes: fire.nodes } : {}),
        notice: fireLocationDetail ? `${fireLocationDetail} 发生火情，请按指引撤离` : '',
      }, { from: 'system' }))
    } else if (firePublishedRef.current) {
      // 只有确实发布过火警才发解除，避免"系统端刷新页面"误清用户端的火警状态
      firePublishedRef.current = false
      bus.publish(createEvent('clear', {}, { from: 'system' }))
    }
  }, [fire])

  // 接收用户端上报（火源 / 求助）：局域网中继或同机广播送达后，弹提示并积累到链路面板
  useEffect(() => {
    const bus = sharedEventBus()
    bus.start()
    const unsubscribe = bus.onEvent((event) => {
      if (event.from === 'system') return
      if (event.kind === 'report' || event.kind === 'status') {
        setPeerEvents((current) => [...current.filter((item) => item.id !== event.id), event].slice(-12))
        if (event.kind === 'report') {
          const summary = peerReportSummary(event)
          setToast(`用户端上报：${summary?.place ?? ''} · ${summary?.text ?? ''}`)
          setPeerReport(summary)
        }
      }
    })
    return () => unsubscribe()
  }, [])

  // 首次用户交互时解锁音频（浏览器自动播放策略）
  useEffect(() => {
    const unlock = async () => {
      const ok = await unlockAudio()
      if (ok) setAudioReady(true)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  // 滚动后把页标题收进顶栏（iOS 大标题收起行为）
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    localStorage.setItem('thermalGuardCameras', JSON.stringify(cameras))
  }, [cameras])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (connection === 'connected') return undefined
    const timer = setInterval(() => setPhase((value) => value + 1), 320)
    return () => clearInterval(timer)
  }, [connection])

  useEffect(() => {
    if (connection !== 'connected') setFrame(createFrame(phase))
  }, [phase, connection])

  useEffect(() => () => {
    clearInterval(timerRef.current)
    socketRef.current?.close()
  }, [])

  const handleImage = (file) => {
    if (!file) return
    armedRef.current = true
    const reader = new FileReader()
    reader.onload = (event) => {
      setImage(event.target.result)
      setFileName(file.name)
      setDetected(false)
      setProgress(0)
    }
    reader.readAsDataURL(file)
  }

  const resetDetection = () => {
    clearInterval(timerRef.current)
    armedRef.current = true
    setImage('')
    setFileName('')
    setDetected(false)
    setDetecting(false)
    setProgress(0)
  }

  const runDetection = () => {
    if (!image || detecting) return
    clearInterval(timerRef.current)
    armedRef.current = true
    setDetected(false)
    setDetecting(true)
    setProgress(3)
    let value = 3
    timerRef.current = setInterval(() => {
      value += Math.round(Math.random() * 9 + 8)
      if (value >= 100) {
        value = 100
        clearInterval(timerRef.current)
        window.setTimeout(() => {
          // 检测场景按火情工况生成，保证演示结果与后续报警、逃生长流程一致
          const nextResult = createFrame(phase, 'fire')
          setResult(nextResult)
          setFrame(nextResult)
          setDetected(true)
          setDetecting(false)
          const effectiveRisk = riskFromMaxTemp(nextResult.maxTemp, { high: settings.highThreshold, medium: settings.mediumThreshold })
          setAlerts((current) => [{ id: `local-${Date.now()}`, time: nowText(), risk: effectiveRisk, zone: activeDevice?.location || '手机端实时检测', temp: nextResult.maxTemp, hotspots: nextResult.hotspots.length, kind: 'detection', handled: false }, ...current].slice(0, 60))
        }, 260)
      }
      setProgress(Math.min(value, 99))
    }, 110)
  }

  const disconnect = () => {
    socketRef.current?.close()
    socketRef.current = null
    setActiveDevice(null)
    setConnection('simulator')
    setError('')
  }

  const connectDevice = (device) => {
    disconnect()
    let parsed
    try { parsed = new URL(device.url) } catch { setConnection('failed'); setError('设备地址格式不正确'); return }
    if (location.protocol === 'https:' && parsed.protocol === 'ws:') {
      setConnection('failed')
      setError('手机网页使用 HTTPS 时不能连接 ws://，请改用 wss:// 安全地址。')
      return
    }
    setActiveDevice(device)
    setConnection('connecting')
    setError('')
    const socket = new WebSocket(device.url)
    socketRef.current = socket
    socket.onopen = () => setConnection('connected')
    socket.onmessage = (event) => {
      try { setFrame(normalizePacket(JSON.parse(event.data))) } catch { setError('收到数据，但 JSON 格式不正确') }
    }
    socket.onerror = () => { setConnection('failed'); setError('无法连接设备，请检查地址、网络与安全证书。') }
    socket.onclose = () => { if (socketRef.current === socket) setConnection('simulator') }
  }

  const saveDevice = (id, values) => {
    if (id) setDevices((current) => current.map((device) => device.id === id ? { ...device, ...values } : device))
    else setDevices((current) => [...current, { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}`, ...values }])
  }

  /* ---------------- 报警系统 ---------------- */

  // 检测结果的最终风险等级按用户配置的阈值换算，保证设置真正生效
  const resultRisk = useMemo(
    () => riskFromMaxTemp(result.maxTemp, { high: settings.highThreshold, medium: settings.mediumThreshold }),
    [result.maxTemp, settings.highThreshold, settings.mediumThreshold],
  )
  const riskAdjustedResult = useMemo(() => ({ ...result, risk: resultRisk }), [result, resultRisk])

  const elapsedSec = fire ? Math.max(0, (nowMs - fire.startedAt) / 1000) : 0
  const route = useMemo(
    () => planRoute({ startId: positionNodeId(position.floor, position.spot), fire, elapsedSec, blocked: blockedNodes }),
    [position.floor, position.spot, fire, elapsedSec, blockedNodes],
  )

  // AR 实景导航（系统端同样可用）：方向、距离、剩余楼层都直接取自同一条疏散路线
  const arStartNode = route?.startId ? BUILDING.nodes[route.startId] : null
  const arNextNode = route?.ok && route.path?.[1] ? BUILDING.nodes[route.path[1]] : null
  const arTargetNode = arNextNode || (route?.ok ? BUILDING.nodes[route.exitId] : null)
  const arBearing = arStartNode && arTargetNode
    ? ((Math.atan2(arTargetNode.x - arStartNode.x, -(arTargetNode.y - arStartNode.y)) * 180) / Math.PI + 360) % 360
    : 0
  const arExitFloor = route?.ok ? BUILDING.nodes[route.exitId]?.floor ?? 1 : null
  const arRemainingFloors = arExitFloor == null
    ? '—'
    : arExitFloor === position.floor
      ? '同层'
      : `${Math.abs(position.floor - arExitFloor)} 层 · ${position.floor > arExitFloor ? '下行' : '上行'}`
  const arProximity = route?.ok ? Math.max(0, Math.min(1, 1 - route.meters / 120)) : 0
  const arAtExit = Boolean(route?.ok && route.meters <= 6)
  const arProximityText = !route?.ok ? '' : arAtExit ? '就在这里' : arProximity > 0.62 ? '就在附近' : arProximity > 0.3 ? '接近中' : '按箭头前进'

  // 校园 3D：把火源（可能多处）映射为校园建筑 + 楼层
  const campusFires = useMemo(() => {
    if (!fire) return []
    const list = Array.isArray(fire.nodes) && fire.nodes.length ? fire.nodes : [fire.nodeId]
    return list.filter(Boolean).map((nodeId) => ({ nodeId }))
  }, [fire])

  // 人流：报警时每秒推进一次；封锁的节点（如 A4 = A 梯）折算成楼梯封锁，直接影响通行能力
  const blockedStairIds = useMemo(
    () => [...new Set((blockedNodes ?? []).map((nodeId) => String(nodeId)[0]).filter((spot) => spot === 'A' || spot === 'B'))],
    [blockedNodes],
  )
  const floorOfNode = (nodeId, fallback = position.floor) => BUILDING?.nodes?.[nodeId]?.floor ?? fallback
  const fireFloorForCrowd = fire ? floorOfNode(fire.nodeId, fire.floor ?? position.floor) : null
  const fireLocationDetail = fire
    ? `${campusLocationForNode(fire.nodeId)?.label ?? `${fireFloorForCrowd} 楼`}${fire.floor ? `（${fire.floor} 楼·${fire.nodeId}）` : `（${fire.nodeId}）`}`
    : null

  // 处置报告（导出为 PDF）：把当前这一刻的判定、路线与人流写进同一份报告
  const buildIncidentReport = () => ({
    system: '热感哨兵 · AI 火警预警与动态疏散系统',
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    location: fireLocationDetail || alarm?.location || '澳门科技大学校园数字孪生',
    risk: alarm?.risk || resultRisk,
    riskLabel: riskTitle(alarm?.risk || resultRisk),
    riskIndex: Math.min(99, Math.round(Number(result.maxTemp) || 0)),
    maxTemp: Number(result.maxTemp) || 0,
    hotspotCount: result.hotspots?.length ?? 0,
    recommendedExit: route?.ok ? route.exitLabel : '最近安全出口',
    evacuationDistance: route?.ok ? Math.round(route.meters) : null,
    evacuationEta: route?.ok ? Math.round(route.meters / 1.2) : null,
    occupancy: crowd?.totals?.remaining ?? null,
    notes: [
      `起火点：${fireLocationDetail || '未定位'}`,
      alarm?.mode === 'drill' ? '本次为演练报警' : null,
      `在场人员：共 ${crowd?.totals?.total ?? '—'} 人，未撤离 ${crowd?.totals?.remaining ?? '—'} 人`,
      blockedNodes?.length ? `已封锁通道：${blockedNodes.join('、')}` : null,
    ].filter(Boolean).join('；'),
  })

  // 阶段二：起火时给救援端生成一段简报（配了本地模型就由模型写，否则用本机规则）
  useEffect(() => {
    if (!fire) {
      setRescueBrief(null)
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const outcome = await aiCommand({
        phase: 'response',
        fire,
        route: route?.ok ? { ok: true, meters: Math.round(route.meters), exitLabel: route.exitLabel } : { ok: false, reason: route?.reason },
        crowd: crowd?.totals ? { totals: crowd.totals, stairs: crowd.stairs } : null,
        position,
        blocked: blockedNodes,
        userStatus: readUserStatuses(),
        // 感知层来源：装了 YOLO 就标出来，方便界面区分"感知"和"决策"
        perception: { source: readAiSettings().visionUrl ? 'yolo' : 'thermal-only' },
      }, readAiSettings())
      if (!cancelled) setRescueBrief(outcome)
    }, 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fire, route?.ok, route?.meters, route?.exitLabel, crowd?.totals?.remaining, position.floor, position.spot, blockedNodes])

  // ?demo=1 一键演示模式（人流节奏放快、并高亮人流监看面板）
  const demoMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1'
  useEffect(() => {
    if (!fire) {
      setCrowd((current) => (current.alarm ? createCrowdState() : current))
      setCrowdHistory((current) => (current.length ? [] : current))
      return undefined
    }
    // 演示模式下人流推进更快，便于在现场看到逐层清空的过程
    const tickMs = demoMode ? 600 : 1000
    const timer = window.setInterval(() => {
      setCrowd((current) => {
        const next = advanceCrowd(current, demoMode ? 0.6 : 1, {
          alarm: true,
          fireFloor: floorOfNode(fire.nodeId, fire.floor ?? position.floor),
          blockedStairs: blockedStairIds,
        })
        setCrowdHistory((history) => [...history, {
          at: Date.now(),
          evacuated: next.totals.evacuated,
          remaining: next.totals.remaining,
          floors: next.floors.map((floor) => floor.remaining),
        }].slice(-72))
        return next
      })
    }, tickMs)
    return () => window.clearInterval(timer)
  }, [fire, blockedStairIds, position.floor, demoMode])

  // ?demo=1 一键演示：按脚本自动推进「检测 → 报警 → 蔓延 → 人流 → 用户端」
  useEffect(() => {
    if (!demoMode) return undefined
    const timers = []
    const plan = [
      {
        at: 900,
        step: 1,
        label: '载入示例热像图并开始 AI 检测',
        run: () => {
          setImage(DEMO_THERMAL)
          setFileName('示例热成像-01.jpg')
          setDetected(false)
          window.setTimeout(() => runDetection(), 500)
        },
      },
      {
        at: 7000,
        step: 2,
        label: '检测判定高风险 → 自动触发全屏报警（含火情位置）',
        run: () => {
          const floor = 4
          const startedAt = Date.now()
          setFire({ nodeId: `C${floor}`, floor, startedAt, mode: 'live' })
          pushAlarm({
            mode: 'live',
            startedAt,
            temp: 78.4,
            hotspots: 3,
            location: `综合教学楼 ${floor} 楼走廊中段`,
            sourceLabel: '热成像 AI 检测',
          })
        },
      },
      {
        at: 14000,
        step: 3,
        label: '火势蔓延到上一层 → 多火源同时避开',
        run: () => setFire((current) => {
          if (!current) return current
          const nodes = Array.isArray(current.nodes) && current.nodes.length ? current.nodes : [current.nodeId]
          const topFloor = Math.max(...nodes.map((id) => Number(String(id).replace(/\D/g, '')) || 1))
          if (topFloor >= FLOOR_COUNT) return current
          return { ...current, nodes: [...nodes, `C${topFloor + 1}`] }
        }),
      },
      {
        at: 21000,
        step: 4,
        label: '看每层人流与楼梯负载（逃生页 · 人流监看）',
        run: () => {
          setOverlayOpen(false)
          setActiveTab('evacuation')
        },
      },
      {
        at: 38000,
        step: 5,
        label: '同一浏览器打开用户端：极简表盘 + 距离/方向指引',
        run: () => setNotice({ id: Date.now(), text: '演示结束：可切到「用户端」标签查看极简逃生指引（距离+方向）', tone: 'info' }),
      },
    ]
    plan.forEach((item) => {
      timers.push(window.setTimeout(() => {
        setDemoStep(item.step)
        item.run()
      }, item.at))
    })
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [demoMode])

  const alarmActive = Boolean(alarm && !alarm.acknowledged)
  const alarmId = alarm?.id
  const alarmEscalated = Boolean(alarm?.escalated)
  const alarmMode = fire?.mode || alarm?.mode || 'live'

  const pushAlarm = (payload) => {
    const id = `alarm-${payload.startedAt}-${Math.random().toString(36).slice(2, 6)}`
    setAlarm({ id, acknowledged: false, escalated: false, risk: 'high', sourceLabel: '热成像 AI 检测', mode: 'live', ...payload })
    setOverlayOpen(true)
    setNowMs(Date.now())
    setActiveTab('evacuation')
    setAlerts((current) => [{
      id,
      kind: 'alarm',
      mode: payload.mode || 'live',
      risk: 'high',
      temp: payload.temp,
      time: nowText(),
      zone: payload.location || '手机端实时检测',
      hotspots: payload.hotspots ?? 0,
      handled: false,
      acknowledged: false,
    }, ...current].slice(0, 60))
  }

  // 检测判定为高风险时自动触发报警；中风险只出提示，不打断现场
  useEffect(() => {
    if (!settings.autoTrigger || !detected) return
    if (resultRisk === 'low') {
      armedRef.current = true
      return
    }
    if (resultRisk === 'medium') {
      if (armedRef.current) setNotice({ id: Date.now(), text: `检测到中风险温升 ${result.maxTemp.toFixed(1)}°C，建议现场核查`, tone: 'warn' })
      return
    }
    if (resultRisk === 'high' && armedRef.current) {
      armedRef.current = false
      const floor = activeDevice?.floor || position.floor
      const startedAt = Date.now()
      setFire({ nodeId: `C${floor}`, floor, startedAt, mode: 'live' })
      pushAlarm({
        mode: 'live',
        startedAt,
        temp: result.maxTemp,
        hotspots: result.hotspots.length,
        location: `${activeDevice?.location || '手机端实时检测'} · ${floor} 楼`,
      })
      // 真实检测判定为高风险时也要生成火源对象：用户端要靠它才知道"哪里起火"
      setFire({
        nodeId: positionNodeId(floor, position.spot),
        floor,
        startedAt,
        mode: 'live',
        peakTemp: result.maxTemp,
      })
    }
  }, [detected, resultRisk, result.maxTemp])

  // 警笛
  useEffect(() => {
    if (!alarmActive || !settings.sound || !audioReady) {
      stopSiren()
      return undefined
    }
    startSiren(alarmEscalated ? 'escalated' : alarmMode === 'drill' ? 'drill' : 'normal')
    return () => stopSiren()
  }, [alarmId, alarmActive, alarmEscalated, alarmMode, settings.sound, audioReady])

  // 震动（iOS Safari 不支持）
  useEffect(() => {
    if (!alarmActive || !settings.vibrate || !supportsVibration()) return undefined
    vibrateAlarm()
    const timer = setInterval(vibrateAlarm, ALARM_VIBRATION_INTERVAL)
    return () => {
      clearInterval(timer)
      stopVibrate()
    }
  }, [alarmId, alarmActive, settings.vibrate])

  // 语音播报
  useEffect(() => {
    if (!alarmActive || !settings.voice) {
      stopSpeak()
      return undefined
    }
    const text = alarmMode === 'drill' ? '这是一次火警演练，请沿逃生路线离开' : '检测到火警，请立即沿逃生路线撤离，不要搭乘电梯'
    speak(text)
    const timer = setInterval(() => speak(text), alarmEscalated ? 5000 : 9000)
    return () => {
      clearInterval(timer)
      stopSpeak()
    }
  }, [alarmId, alarmActive, alarmEscalated, alarmMode, settings.voice])

  // 未确认升级
  useEffect(() => {
    if (!alarm || alarm.acknowledged || !settings.escalateSec) return undefined
    const delay = Math.max(0, alarm.startedAt + settings.escalateSec * 1000 - Date.now())
    const timer = setTimeout(() => {
      setAlarm((current) => (current && !current.acknowledged ? { ...current, escalated: true } : current))
    }, delay)
    return () => clearTimeout(timer)
  }, [alarmId, alarm?.acknowledged, alarm?.startedAt, settings.escalateSec])

  // 标签页闪烁提醒
  useEffect(() => {
    if (!alarmActive) return undefined
    const original = document.title
    let flip = false
    const timer = setInterval(() => {
      flip = !flip
      document.title = flip ? '🚨 火警警报' : '请立即撤离'
    }, 900)
    return () => {
      clearInterval(timer)
      document.title = original
    }
  }, [alarmId, alarmActive])

  useEffect(() => {
    if (!notice || notice.tone !== 'warn') return undefined
    const timer = setTimeout(() => setNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [notice])

  const enableSound = async () => {
    const ok = await unlockAudio()
    setAudioReady(ok)
  }

  const acknowledgeAlarm = () => {
    if (!alarm) return
    stopSiren()
    stopSpeak()
    stopVibrate()
    setAlarm({ ...alarm, acknowledged: true, acknowledgedAt: Date.now() })
    setAlerts((current) => current.map((item) => (item.id === alarm.id ? { ...item, acknowledged: true } : item)))
  }

  const reenforceAlarm = () => {
    stopSiren()
    stopSpeak()
    setAlarm((current) => (current ? { ...current, acknowledged: false, escalated: false, startedAt: Date.now() } : current))
    setNowMs(Date.now())
  }

  const resolveAlarm = () => {
    stopSiren()
    stopSpeak()
    stopVibrate()
    setAlarm(null)
    setOverlayOpen(false)
    setFire(null)
    if (resultRisk === 'low') {
      armedRef.current = true
    } else {
      setNotice({ id: Date.now(), text: `已解除警报，但检测结果仍为${riskTitle(resultRisk)}，请确认现场安全后再重新布防`, tone: 'info' })
    }
  }

  const startDrill = (floor, spot) => {
    const startedAt = Date.now()
    armedRef.current = false
    setPosition((current) => (current.floor === floor ? current : { ...current, floor }))
    setFire({ nodeId: `${spot}${floor}`, floor, startedAt, mode: 'drill' })
    pushAlarm({
      mode: 'drill',
      startedAt,
      temp: result.maxTemp,
      hotspots: result.hotspots.length,
      location: `演练：${floor} 楼${SPOT_LABELS[spot] || '走廊中段'}`,
      sourceLabel: '火警演练',
    })
  }

  const stopDrill = () => {
    stopSiren()
    stopSpeak()
    stopVibrate()
    setAlarm(null)
    setOverlayOpen(false)
    setFire(null)
  }

  // 演示多火源：让火势蔓延到上一层走廊，路线需要同时避开两处
  const spreadFireUp = () => {
    if (!fire) {
      setNotice({ id: Date.now(), text: '请先点燃起火点，再让火势蔓延', tone: 'info' })
      return
    }
    const nodes = Array.isArray(fire.nodes) && fire.nodes.length ? fire.nodes : [fire.nodeId]
    const topFloor = Math.max(...nodes.map((id) => Number(String(id).replace(/\D/g, '')) || 1))
    if (topFloor >= FLOOR_COUNT) {
      setNotice({ id: Date.now(), text: '已经蔓延到顶层，无法继续向上', tone: 'info' })
      return
    }
    const added = `C${topFloor + 1}`
    if (nodes.includes(added)) return
    setFire({ ...fire, nodes: [...nodes, added] })
    setNotice({
      id: Date.now(),
      text: `火势已蔓延到 ${topFloor + 1} 楼走廊：系统端与用户端现在都要同时避开 ${nodes.length + 1} 处火源`,
      tone: 'warn',
    })
  }

  // 保证中风险阈值始终低于高温报警阈值
  const updateSettings = (patch) => setSettings((current) => {
    const next = { ...current, ...patch }
    if (next.mediumThreshold >= next.highThreshold) {
      if ('highThreshold' in patch) next.mediumThreshold = Math.max(35, next.highThreshold - 5)
      else next.highThreshold = Math.min(90, next.mediumThreshold + 5)
    }
    return next
  })

  const toggleBlockedNode = (id) => {
    setBlockedNodes((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) || cameras[0]

  const saveCamera = (values) => {
    if (cameraSheet?.camera) {
      setCameras((current) => current.map((camera) => camera.id === cameraSheet.camera.id ? { ...camera, ...values } : camera))
    } else {
      const next = { id: globalThis.crypto?.randomUUID?.() || `camera-${Date.now()}`, ...values }
      setCameras((current) => [...current, next])
      setSelectedCameraId(next.id)
    }
    setCameraSheet(null)
  }

  const shareCamera = async (camera) => {
    if (!camera?.public) {
      setToast('授权监控不可公开分享')
      return
    }
    const url = new URL(location.href)
    url.search = ''
    url.hash = ''
    url.searchParams.set('camera', encodeCamera(camera))
    url.searchParams.set('view', 'camera')
    try {
      await navigator.clipboard.writeText(url.toString())
      setToast('公开监控分享链接已复制')
    } catch {
      setToast('复制失败，请使用浏览器地址栏分享')
    }
  }

  const page = useMemo(() => {
    if (activeTab === 'camera') {
      return (
        <>
          <HardwareFeed
            onFrame={(nextFrame) => {
              // 硬件热像接入检测链路：帧结构一致，报警阈值/危险场/疏散自动复用
              setFrame(nextFrame)
              setResult(nextFrame)
            }}
          />
          <CameraPage cameras={cameras} selectedCamera={selectedCamera} frame={frame} connection={connection} onSelect={(camera) => setSelectedCameraId(camera.id)} onAdd={() => setCameraSheet({ camera: null })} onEdit={(camera) => setCameraSheet({ camera })} onDelete={(id) => { setCameras((current) => current.filter((camera) => camera.id !== id)); if (selectedCameraId === id) setSelectedCameraId(cameras.find((camera) => camera.id !== id)?.id || '') }} canShare={Boolean(selectedCamera?.public)} onShare={shareCamera} />
        </>
      )
    }
    if (activeTab === 'map') {
      return (
        <section className="mobile-card campus-card">
          <div className="card-title">
            <div><strong>校园三维态势</strong><small>澳门科技大学校园微缩模型 · 火源定位到具体楼层</small></div>
            <div className="view-switcher view-switcher-compact">
              <button type="button" className={mapView === 'campus' ? 'active' : ''} onClick={() => setMapView('campus')}>校园 3D</button>
              <button type="button" className={mapView === 'city' ? 'active' : ''} onClick={() => setMapView('city')}>城市热力图</button>
            </div>
          </div>
          {mapView === 'campus' ? (
            <>
              <div className="campus-3d-holder">
                <Suspense fallback={<div className="campus-3d-loading">正在加载校园三维模型…</div>}>
                  <Campus3D fires={campusFires} onPick={setCampusPick} />
                </Suspense>
              </div>
              <p className="card-hint">
                {fire
                  ? `当前火源：${campusFires.map((item) => campusLocationForNode(item.nodeId)?.label).filter(Boolean).join('、') || '未映射到校园'}`
                  : '暂无火情。拖动旋转、滚轮缩放，点击楼体可查看该楼楼层。'}
                {campusPick ? `｜已选 ${campusPick.building.name}（共 ${campusPick.building.floors} 层，你点了第 ${campusPick.floor} 层）` : ''}
              </p>
              <p className="card-hint">{SPOT_MAPPING_NOTE}</p>
            </>
          ) : (
            <CityMap fire={fire} activeDevice={activeDevice} />
          )}
        </section>
      )
    }
    // 「预警」标签：分段控件在事件记录与报警设置之间切换
    if (activeTab === 'alerts' && alertSection === 'settings') {
      return (
        <AlarmCenterView
          alarm={alarm}
          fire={fire}
          alerts={alerts}
          settings={settings}
          audioReady={audioReady}
          onSettingsChange={updateSettings}
          onManualAlarm={() => pushAlarm({ mode: 'manual', startedAt: Date.now(), temp: result.maxTemp, hotspots: result.hotspots.length, location: '手动触发（自检）', sourceLabel: '手动报警' })}
          onStartDrill={startDrill}
          onStopDrill={stopDrill}
          onClearFire={() => (alarm ? stopDrill() : setFire(null))}
          onEnableSound={enableSound}
          onMarkHandled={(id) => setAlerts((current) => current.map((item) => (item.id === id ? { ...item, handled: true } : item)))}
          onClearAlerts={() => setAlerts([])}
        />
      )
    }
    if (activeTab === 'alerts') return <AlertsPage alerts={alerts} onToast={setToast} />
    if (activeTab === 'evacuation') {
      return (
        <>
        <EvacuationView
          route={route}
          fire={fire}
          position={position}
          blocked={blockedNodes}
          nowMs={nowMs}
          crowd={crowd}
          crowdHistory={crowdHistory}
          crowdDemo={demoMode && demoStep === 4}
          onPositionChange={setPosition}
          onToggleBlock={toggleBlockedNode}
          onStartDrillAt={(nodeId, floor) => startDrill(floor, nodeId[0])}
          onSpreadFire={spreadFireUp}
          onClearFire={() => setFire(null)}
          onOpenAr={() => setArOpen(true)}
        />
        <RescueBriefPanel
          fire={fire}
          position={position}
          crowd={crowd}
          blocked={blockedNodes}
          rescueBrief={rescueBrief}
        />
        <VitalSignsPanel floor={position.floor} />
        </>
      )
    }
    if (activeTab === 'dashboard') return dashView === 'about' ? <AboutPage onBack={() => setDashView('dashboard')} /> : <DashboardPage onOpenAbout={() => setDashView('about')} />
    return (
      <>
        <HomePage inputCameraRef={inputCameraRef} inputGalleryRef={inputGalleryRef} image={image} fileName={fileName} detecting={detecting} progress={progress} detected={detected} result={riskAdjustedResult} onImage={handleImage} onSample={() => { setImage(DEMO_THERMAL); setFileName('示例热成像-01.jpg'); setDetected(false) }} onReset={resetDetection} onDetect={runDetection} />
        <PreventionPanel
          result={riskAdjustedResult}
          thresholds={{ high: settings.highThreshold, medium: settings.mediumThreshold }}
          history={frameHistory}
          floor={position.floor}
          image={image}
          onAlarm={() => pushAlarm({ mode: 'auto', startedAt: Date.now(), temp: result.maxTemp, hotspots: result.hotspots?.length ?? 0, location: `AI 预防判定 · ${position.floor} 楼`, sourceLabel: 'AI 判定' })}
          onNotify={async (notice) => {
            const ok = await copyNotice(notice)
            setToast(ok ? '周边通知已复制，可粘贴到广播或群消息' : notice.slice(0, 40))
          }}
        />
      </>
    )
  }, [activeTab, alertSection, dashView, alerts, cameras, selectedCamera, selectedCameraId, image, fileName, detecting, progress, detected, riskAdjustedResult, phase, alarm, fire, settings, audioReady, route, position, blockedNodes, nowMs, activeDevice, frameHistory, rescueBrief, crowd])

  return (
    <div className={`mobile-app-shell ${alarm ? 'has-alarm' : ''}`}>
      {demoMode && demoStep > 0 && (
        <div className="demo-banner">
          <span className="demo-badge">演示 {demoStep}/5</span>
          <span className="demo-text">
            {['', '载入示例热像图并开始 AI 检测', '检测判定高风险 → 触发全屏报警（含火情位置）', '火势蔓延到上一层 → 多火源同时避开', '看每层人流与楼梯负载（人流监看）', '切到用户端看极简表盘（距离 + 方向）'][demoStep]}
          </span>
        </div>
      )}
      <header className={`mobile-topbar ${scrolled ? 'is-scrolled' : ''}`}>
        <div className="mobile-brand"><span><Flame size={19} /></span><div><strong>热感哨兵</strong><small>AI火警网警</small></div></div>
        <span className="nav-title">
          {activeTab === 'alerts'
            ? (alertSection === 'settings' ? '报警设置' : '预警记录')
            : activeTab === 'dashboard'
              ? (dashView === 'about' ? '关于项目' : '数据看板')
              : tabs.find((item) => item.id === activeTab)?.navLabel || ''}
        </span>
        <div className="top-actions">
          <ConnectionBadge state={connection} />
          <button type="button" className="ai-entry" title="AI 指挥 · 本地模型接口" onClick={() => setShowAiSheet(true)}>
            <Cpu size={15} /><span>AI 指挥</span>
          </button>
          <button type="button" className="ai-entry link-entry" title="两端联通 · 局域网中继与离线码" onClick={() => setShowLinkSheet(true)}>
            <Link2 size={15} /><span>链路</span>
            {peerEvents.length > 0 && <em className="link-count">{peerEvents.length}</em>}
          </button>
          <a className="peer-link" href="./user-app.html" title="切换到用户端">
            <Smartphone size={14} /><span>用户端</span>
          </a>
          <button type="button" aria-label="设备管理" onClick={() => setShowDevices(true)}><Cable size={18} /></button>
        </div>
      </header>

      {alarm && !overlayOpen && (
        <button className={`alarm-banner ${alarm.acknowledged ? 'is-muted' : ''}`} type="button" onClick={() => setOverlayOpen(true)}>
          <ShieldAlert size={16} />
          <span>{alarm.acknowledged ? '报警已静音，危险未解除' : '火警报警进行中'}</span>
          <strong>返回警报</strong>
        </button>
      )}

      {/* 用户端上报：指挥人员在这里一眼看到位置与内容，并可定位或直接拉响警报 */}
      {/* 报警进行中也要显示：这时候指挥人员最需要知道楼里有人报了什么 */}
      {peerReport && (
        <div className={`peer-report tone-${peerReport.severity}`}>
          <div className="peer-report-head">
            <span className="peer-report-tag">{peerReport.label}</span>
            <small>{new Date(peerReport.at).toLocaleTimeString('zh-CN', { hour12: false })} · 来自用户端</small>
          </div>
          <strong>{peerReport.place}</strong>
          <p>{peerReport.text}</p>
          <div className="peer-report-actions">
            <button
              type="button"
              className="peer-report-locate"
              onClick={() => {
                if (peerReport.floor) {
                  setPosition((current) => ({ floor: peerReport.floor, spot: peerReport.spot && ['A', 'C', 'B'].includes(peerReport.spot) ? peerReport.spot : current.spot }))
                }
                setActiveTab('evacuation')
                setToast(`已定位到上报位置：${peerReport.place}`)
              }}
            >
              <MapPin size={14} />定位到该位置
            </button>
            <button
              type="button"
              className="peer-report-alarm"
              onClick={() => {
                const floor = peerReport.floor ?? position.floor
                const spot = peerReport.spot && ['A', 'C', 'B'].includes(peerReport.spot) ? peerReport.spot : position.spot
                const startedAt = Date.now()
                setPosition({ floor, spot })
                setFire({ nodeId: positionNodeId(floor, spot), floor, startedAt, mode: 'live' })
                pushAlarm({
                  mode: 'live',
                  startedAt,
                  temp: result.maxTemp,
                  hotspots: 0,
                  location: `用户端上报：${floor} 楼${SPOT_LABELS[spot] || ''}`,
                  sourceLabel: '用户端上报',
                })
                setPeerReport(null)
              }}
            >
              <ShieldAlert size={14} />确认火情并拉响警报
            </button>
            <button type="button" onClick={() => setPeerReport(null)}>先忽略</button>
          </div>
        </div>
      )}

      {notice && !alarm && (
        <div className={`warn-banner tone-${notice.tone || 'warn'}`}>
          <TriangleAlert size={15} />
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      )}

      {settings.sound && !audioReady && !alarm && (
        <button className="warn-banner is-action" type="button" onClick={enableSound}>
          <Volume2 size={15} />
          <span>点击启用报警声音，否则火警时只有画面提示</span>
        </button>
      )}

      {activeTab === 'alerts' && (
        <div className="segmented-wrap">
          <div className="segmented" role="tablist" aria-label="预警内容切换">
            {alertSections.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={alertSection === id}
                className={alertSection === id ? 'active' : ''}
                onClick={() => setAlertSection(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="mobile-main">{page}</main>
      <nav className="mobile-tabs">
        {tabs.map(({ id, label, icon: Icon }) => <button type="button" className={activeTab === id ? 'active' : ''} key={id} onClick={() => setActiveTab(id)}><Icon size={20} /><span>{label}</span></button>)}
      </nav>
      {showDevices && <DeviceSheet devices={devices} activeDevice={activeDevice} connection={connection} error={error} onClose={() => setShowDevices(false)} onConnect={connectDevice} onDisconnect={disconnect} onSave={saveDevice} onDelete={(id) => setDevices((current) => current.filter((device) => device.id !== id))} />}
      {showAiSheet && <AiCommandSheet onClose={() => setShowAiSheet(false)} onSaved={() => setToast('AI 指挥设置已保存')} />}
      {showLinkSheet && (
        <LinkSheet
          onClose={() => setShowLinkSheet(false)}
          latestFire={fire}
          noticeText={fireLocationDetail ? `${fireLocationDetail} 发生火情，请按指引撤离` : ''}
        />
      )}
      {arOpen && (
        <ArNavigator
          route={route}
          fire={fire}
          proximity={arProximity}
          atExit={arAtExit}
          proximityText={arProximityText}
          bearing={arBearing}
          targetLabel={route?.ok ? route.exitLabel : '最近安全出口'}
          remainingFloors={arRemainingFloors}
          positionSource={`指挥端视角 · ${position.floor} 楼 ${position.spot}`}
          onClose={() => setArOpen(false)}
        />
      )}
      {cameraSheet && <CameraSheet editing={cameraSheet.camera} onClose={() => setCameraSheet(null)} onSave={saveCamera} />}
      {toast && <div className="toast-message">{toast}</div>}
      {alarm && overlayOpen && (
        <AlarmOverlay
          alarm={alarm}
          nowMs={nowMs}
          soundOn={settings.sound}
          audioReady={audioReady}
          locationDetail={fireLocationDetail}
          onEvacuate={() => {
            setOverlayOpen(false)
            setActiveTab('evacuation')
          }}
          onAcknowledge={acknowledgeAlarm}
          onReenforce={reenforceAlarm}
          onResolve={resolveAlarm}
          onStopDrill={stopDrill}
          onSpreadFire={spreadFireUp}
          onEnableSound={enableSound}
          onExportReport={() => {
            setReportBusy(true)
            exportIncidentPdf(buildIncidentReport())
              .then(() => setToast('处置报告已保存为 PDF 文件'))
              .catch(() => {
                const opened = openPdfReport(buildIncidentReport())
                setToast(opened ? '已在新标签页打开处置报告，可按 ⌘P 存为 PDF' : '报告生成失败，请重试')
              })
              .finally(() => setReportBusy(false))
          }}
          reportBusy={reportBusy}
          onOpenLink={() => {
            setOverlayOpen(false)
            setToast('正在打开链路面板…')
            // 等浮层先卸载再开面板：否则同一次点击会"穿透"到新面板的遮罩上把它立刻关掉
            window.setTimeout(() => setShowLinkSheet(true), 80)
          }}
        />
      )}
    </div>
  )
}
