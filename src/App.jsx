import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Cpu,
  Crosshair,
  Database,
  Eye,
  FileImage,
  Flame,
  Gauge,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  MapPin,
  Play,
  Radio,
  RotateCcw,
  ScanLine,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Thermometer,
  TrendingUp,
  Upload,
  UploadCloud,
  Users,
  Wifi,
  Zap,
} from 'lucide-react'

const DEMO_THERMAL_SRC = `${import.meta.env.BASE_URL}demo-thermal.jpg`

const navItems = [
  { label: '首页', href: '#home' },
  { label: '在线检测', href: '#detection' },
  { label: '数据看板', href: '#dashboard' },
  { label: '项目介绍', href: '#about' },
]

const features = [
  {
    icon: ScanSearch,
    index: '01',
    title: 'AI火警网警智能识别',
    text: '融合 YOLO 目标检测与热成像温度轮廓，在明火与烟雾出现前发现异常热源。',
    tag: '视觉智能',
  },
  {
    icon: Crosshair,
    index: '02',
    title: '高温区域精准定位',
    text: '将疑似热源映射至画面坐标，快速圈定风险区域，为现场排查提供直观依据。',
    tag: '精准定位',
  },
  {
    icon: ShieldAlert,
    index: '03',
    title: '多级风险分级预警',
    text: '依据温度阈值、区域面积与扩散趋势，输出低、中、高三级风险与处置建议。',
    tag: '风险引擎',
  },
]

const statCards = [
  { label: '累计检测图像', value: '12,846', unit: '张', change: '+18.6%', icon: FileImage, tone: 'blue', points: [28, 32, 30, 42, 48, 44, 58, 65, 72, 80] },
  { label: '累计预警次数', value: '1,329', unit: '次', change: '+12.4%', icon: AlertTriangle, tone: 'orange', points: [38, 30, 42, 50, 48, 61, 58, 74, 70, 87] },
  { label: '中高风险占比', value: '23.8', unit: '%', change: '-2.1%', icon: Gauge, tone: 'cyan', points: [72, 68, 70, 62, 65, 58, 52, 55, 48, 46] },
  { label: '平均响应时间', value: '1.8', unit: '秒', change: '较上月 -0.4s', icon: Clock3, tone: 'green', points: [82, 76, 70, 66, 61, 55, 48, 42, 36, 30] },
]

const trendData = {
  labels: ['08/18', '08/21', '08/24', '08/27', '08/30', '09/02', '09/05', '09/08', '09/11'],
  values: [642, 710, 688, 826, 902, 871, 1064, 1188, 1276],
}

const initialResult = {
  level: '高风险',
  levelKey: 'high',
  hotspots: 3,
  maxTemp: 86.4,
  confidence: 96.8,
  duration: 1.72,
  advice: '检测到多处疑似高温热源，其中 1 处温度与扩散趋势显著。建议立即核实设备运行状态，切断非必要电源，使用专业测温与消防器材进行现场复核，并保持安全疏散通道畅通。',
  boxes: [
    { x: 31, y: 24, w: 18, h: 22, temp: '86.4°C', confidence: '96.8%' },
    { x: 64, y: 18, w: 15, h: 20, temp: '71.2°C', confidence: '91.4%' },
    { x: 74, y: 58, w: 13, h: 18, temp: '64.8°C', confidence: '87.6%' },
  ],
}

function useReveal() {
  useEffect(() => {
    const nodes = document.querySelectorAll('[data-reveal]')
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12 },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [])
}

function Logo() {
  return (
    <a className="brand" href="#home" aria-label="AI热感火警风险检测系统首页">
      <span className="brand-mark">
        <Flame size={21} strokeWidth={2.4} />
        <span className="brand-pulse" />
      </span>
      <span className="brand-copy">
        <strong>FireAegis</strong>
        <small>热感智能安防</small>
      </span>
    </a>
  )
}

function TopNav() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`topbar ${scrolled ? 'topbar-scrolled' : ''}`}>
      <div className="nav-shell">
        <Logo />
        <nav className={`nav-links ${menuOpen ? 'mobile-open' : ''}`} aria-label="主导航">
          {navItems.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</a>
          ))}
        </nav>
        <div className="nav-actions">
          <span className="system-status"><span /> 模型在线</span>
          <a className="nav-cta" href="#detection">开始检测 <ArrowRight size={15} /></a>
        </div>
        <button
          className={`mobile-menu ${menuOpen ? 'is-open' : ''}`}
          type="button"
          aria-label={menuOpen ? '收起导航菜单' : '打开导航菜单'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span /><span /><span />
        </button>
      </div>
    </header>
  )
}

function HeroVisual() {
  return (
    <div className="hero-visual" aria-label="AI热成像检测示意">
      <div className="visual-glow" />
      <div className="camera-card">
        <div className="camera-head">
          <div className="camera-id">
            <span className="live-dot" />
            <div><strong>热成像摄像头 01</strong><small>实时热成像流</small></div>
          </div>
          <div className="camera-meta"><span>31 帧/秒</span><Wifi size={14} /></div>
        </div>
        <div className="hero-thermal">
          <img src={DEMO_THERMAL_SRC} alt="工业场景热成像检测预览" />
          <div className="thermal-grid" />
          <div className="scan-beam" />
          <div className="hero-box hero-box-a"><span>86.4°C</span></div>
          <div className="hero-box hero-box-b"><span>71.2°C</span></div>
          <div className="temperature-legend">
            <span>26°C</span><i /><span>90°C</span>
          </div>
        </div>
        <div className="detection-strip">
          <div><ScanLine size={15} /><span>目标识别</span><b>3 处</b></div>
          <div><Thermometer size={15} /><span>最高温度</span><b>86.4°C</b></div>
          <div className="strip-risk"><ShieldAlert size={15} /><span>风险等级</span><b>高风险</b></div>
        </div>
      </div>
      <div className="floating-card float-a"><span className="mini-icon"><Zap size={16} /></span><div><strong>响应速度</strong><b>1.72s</b></div></div>
      <div className="floating-card float-b"><span className="mini-icon"><CheckCircle2 size={16} /></span><div><strong>模型置信度</strong><b>96.8%</b></div></div>
    </div>
  )
}

function Hero() {
  return (
    <section className="hero" id="home">
      <div className="hero-grid" />
      <div className="hero-orb hero-orb-one" />
      <div className="hero-orb hero-orb-two" />
      <div className="section-shell hero-layout">
        <div className="hero-copy">
          <div className="hero-status"><span /><b>AI 火警网警 · 超早期预警</b><i>版本 2.6</i></div>
          <h1>AI热感火警<br /><em>风险检测系统</em></h1>
          <p>超早期温度预警 · 多维度智能判断</p>
          <div className="hero-actions">
            <a className="primary-btn" href="#detection"><Play size={17} fill="currentColor" />开始检测<ArrowRight size={16} /></a>
            <a className="ghost-btn" href="#about"><Eye size={17} />了解技术原理</a>
          </div>
          <div className="hero-proof">
            <div><strong>96.8<span>%</span></strong><small>目标识别置信度</small></div>
            <i />
            <div><strong>1.8<span>秒</span></strong><small>平均检测响应</small></div>
            <i />
            <div><strong>24<span>小时</span></strong><small>连续监测能力</small></div>
          </div>
        </div>
        <HeroVisual />
      </div>
      <div className="hero-bottom">
        <span>向下浏览</span>
        <div><i /><i /><i /></div>
      </div>
    </section>
  )
}

function Features() {
  return (
    <section className="features-section section-shell" aria-labelledby="features-title">
      <div className="section-heading" data-reveal>
        <div>
          <span className="eyebrow"><ScanLine size={14} />核心能力</span>
          <h2 id="features-title">从热成像到风险决策，<br />构建三层智能防线</h2>
        </div>
        <p>面向工业巡检、仓储消防与重点区域安全监测的轻量化 AI 原型系统。</p>
      </div>
      <div className="feature-grid">
        {features.map(({ icon: Icon, index, title, text, tag }, i) => (
          <article className="feature-card" key={title} data-reveal style={{ '--delay': `${i * 100}ms` }}>
            <div className="feature-top"><span className="feature-number">{index}</span><span className="feature-tag">{tag}</span></div>
            <div className="feature-icon"><Icon size={28} strokeWidth={1.8} /></div>
            <h3>{title}</h3>
            <p>{text}</p>
            <div className="feature-line" />
          </article>
        ))}
      </div>
    </section>
  )
}

function ThermalPreview({ image, detected, result, detecting }) {
  return (
    <div className={`thermal-preview ${image ? 'has-image' : ''}`}>
      {image ? (
        <>
          <img src={image} alt="待检测的热成像图像预览" />
          <div className="preview-grid" />
          <div className="preview-corner top-left" />
          <div className="preview-corner top-right" />
          <div className="preview-corner bottom-left" />
          <div className="preview-corner bottom-right" />
          {detecting && <div className="analysis-scan"><span /></div>}
          {detected && result.boxes.map((box, i) => (
            <div
              className="detection-box"
              key={`${box.x}-${box.y}`}
              style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%`, '--box-delay': `${i * 220}ms` }}
            >
              <span className="box-label"><Crosshair size={11} />热区 {String(i + 1).padStart(2, '0')}</span>
              <span className="box-temp">{box.temp}</span>
              <i /><i /><i /><i />
            </div>
          ))}
          {detected && <div className="preview-result-tag"><CheckCircle2 size={13} />检测完成</div>}
        </>
      ) : (
        <div className="upload-prompt">
          <div className="upload-rings"><UploadCloud size={34} /></div>
          <strong>拖拽热成像图片到此处</strong>
          <p>或点击选择本地图片</p>
          <span>支持 JPG / PNG / WEBP，单张不超过 20MB</span>
        </div>
      )}
    </div>
  )
}

function DetectionBoxes() {
  return null
}

function DetectionSection() {
  const [image, setImage] = useState('')
  const [fileName, setFileName] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [detected, setDetected] = useState(false)
  const [result, setResult] = useState(initialResult)
  const [notice, setNotice] = useState('')
  const inputRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => () => clearInterval(timerRef.current), [])

  const resetDetection = () => {
    clearInterval(timerRef.current)
    setDetected(false)
    setDetecting(false)
    setProgress(0)
  }

  const loadImage = (src, name) => {
    resetDetection()
    setImage(src)
    setFileName(name)
    setNotice('')
  }

  const handleFile = (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setNotice('请上传 JPG、PNG 或 WEBP 格式的图片')
      return
    }
    const reader = new FileReader()
    reader.onload = (event) => loadImage(event.target.result, file.name)
    reader.readAsDataURL(file)
  }

  const useSample = () => {
    loadImage(DEMO_THERMAL_SRC, '示例热成像-01.jpg')
  }

  const startDetection = () => {
    if (!image || detecting) return
    if (!inputRef.current) return
    setDetecting(true)
    setDetected(false)
    setProgress(4)
    setNotice('')
    let value = 4
    timerRef.current = setInterval(() => {
      value += Math.round(Math.random() * 9 + 6)
      if (value >= 100) {
        value = 100
        clearInterval(timerRef.current)
        window.setTimeout(() => {
          setProgress(100)
          setResult(initialResult)
          setDetected(true)
          setDetecting(false)
        }, 260)
      }
      setProgress(Math.min(value, 99))
    }, 120)
  }

  return (
    <section className="detection-section" id="detection">
      <div className="detection-grid-bg" />
      <div className="section-shell">
        <div className="section-heading detection-heading" data-reveal>
          <div>
            <span className="eyebrow"><Cpu size={14} />在线检测工作台</span>
            <h2>上传热成像图片，<br />让 AI 发现潜在火情</h2>
          </div>
          <div className="detection-note">
            <span><Radio size={14} />模拟检测引擎已就绪</span>
            <p>上传后将进行目标识别、温度估算与风险分级。</p>
          </div>
        </div>

        <div className="detection-workbench" data-reveal>
          <div className="upload-panel">
            <div className="panel-head">
              <div><span className="step-number">01</span><div><strong>输入热成像图像</strong><small>热成像图像输入</small></div></div>
              <button className="sample-btn" type="button" onClick={useSample}><Sparkles size={14} />载入示例图</button>
            </div>

            <div
              className={`dropzone ${isDragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''}`}
              onDragEnter={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false) }}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files?.[0]) }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleFile(e.target.files?.[0])}
                onClick={(e) => e.stopPropagation()}
              />
              <ThermalPreview image={image} detected={detected} result={result} detecting={detecting} />
              {image && <div className="change-image"><Upload size={14} />更换图片</div>}
            </div>

            <div className="upload-footer">
              <div className="file-info">
                <FileImage size={15} />
                <span>{fileName || '尚未选择文件'}</span>
              </div>
              {image && <button type="button" className="reset-btn" onClick={(e) => { e.stopPropagation(); resetDetection(); setImage(''); setFileName('') }}><RotateCcw size={14} />重置</button>}
            </div>
            {notice && <div className="notice">{notice}</div>}
          </div>

          <div className="result-panel">
            <div className="panel-head">
              <div><span className="step-number">02</span><div><strong>AI 检测结果</strong><small>风险分析</small></div></div>
              <span className={`engine-state ${detecting ? 'is-running' : ''}`}><i />{detecting ? '分析中' : detected ? '分析完成' : '等待检测'}</span>
            </div>

            {!detected && !detecting ? (
              <div className="result-empty">
                <div className="result-radar"><ScanLine size={38} /><i /><i /><i /></div>
                <strong>等待分析热成像数据</strong>
                <p>系统将识别异常热源并给出风险分级<br />与针对性处置建议</p>
                <button className="detect-btn" type="button" disabled={!image} onClick={startDetection}><Play size={16} fill="currentColor" />开始 AI 检测</button>
                {!image && <small>请先上传图片或载入示例图</small>}
              </div>
            ) : detecting ? (
              <div className="analysis-state">
                <div className="analysis-orbit"><LoaderCircle size={48} /><ScanSearch size={21} /></div>
                <strong>AI 正在分析热成像特征</strong>
                <p>目标检测 · 温度估算 · 风险分级</p>
                <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
                <div className="progress-meta"><span>正在分析</span><b>{progress}%</b></div>
              </div>
            ) : (
              <div className="result-content">
                <div className={`risk-card risk-${result.levelKey}`}>
                  <div className="risk-icon">{result.levelKey === 'high' ? <AlertTriangle size={26} /> : <ShieldCheck size={26} />}</div>
                  <div><span>综合风险等级</span><strong>{result.level}</strong><p>{result.levelKey === 'high' ? '建议立即开展现场复核' : '建议按计划进行巡检'}</p></div>
                  <div className="risk-score"><strong>{result.confidence}</strong><span>% 置信度</span></div>
                  <i className="risk-sweep" />
                </div>

                <div className="risk-levels" aria-label="风险等级标准">
                  <div className="level-low"><i /><span><b>低风险</b><small>低于 45°C</small></span></div>
                  <div className="level-mid"><i /><span><b>中风险</b><small>45–65°C</small></span></div>
                  <div className={`level-high ${result.levelKey === 'high' ? 'is-active' : ''}`}><i /><span><b>高风险</b><small>高于 65°C</small></span></div>
                </div>

                <div className="result-metrics">
                  <div><span className="metric-icon orange"><MapPin size={17} /></span><p>识别高温区域</p><strong>{result.hotspots}<small>处</small></strong></div>
                  <div><span className="metric-icon red"><Thermometer size={17} /></span><p>最高温度估算</p><strong>{result.maxTemp}<small>°C</small></strong></div>
                  <div><span className="metric-icon blue"><Clock3 size={17} /></span><p>检测耗时</p><strong>{result.duration}<small>秒</small></strong></div>
                </div>

                <div className="hotspot-list">
                  <div className="subsection-title"><span>热区识别明细</span><small>热区坐标</small></div>
                  {result.boxes.map((box, i) => (
                    <div className="hotspot-row" key={box.temp}>
                      <span className="hotspot-index">{String(i + 1).padStart(2, '0')}</span>
                      <div><strong>疑似高温区域 {i + 1}</strong><small>横向 {box.x} / 纵向 {box.y}</small></div>
                      <b>{box.temp}</b>
                      <em>{box.confidence}</em>
                    </div>
                  ))}
                </div>

                <div className="advice-card">
                  <div><ShieldAlert size={18} /><strong>AI 处置建议</strong></div>
                  <p>{result.advice}</p>
                </div>

                <div className="result-actions">
                  <button type="button" className="secondary-action" onClick={startDetection}><RotateCcw size={14} />重新检测</button>
                  <a href="#dashboard" className="text-action">查看数据看板 <ArrowRight size={14} /></a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function Sparkline({ points, tone }) {
  const width = 170
  const height = 52
  const max = Math.max(...points)
  const min = Math.min(...points)
  const coords = points.map((value, i) => {
    const x = (i / (points.length - 1)) * width
    const y = height - ((value - min) / Math.max(max - min, 1)) * (height - 10) - 5
    return [x, y]
  })
  const line = coords.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  const id = `spark-${tone}`
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={coords.at(-1)[0]} cy={coords.at(-1)[1]} r="3" fill="currentColor" />
    </svg>
  )
}

function TrendChart() {
  const width = 760
  const height = 250
  const padding = { top: 24, right: 24, bottom: 40, left: 48 }
  const max = 1400
  const coords = trendData.values.map((value, i) => {
    const x = padding.left + (i / (trendData.values.length - 1)) * (width - padding.left - padding.right)
    const y = padding.top + (1 - value / max) * (height - padding.top - padding.bottom)
    return [x, y]
  })
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
  const area = `${path} L ${coords.at(-1)[0]} ${height - padding.bottom} L ${coords[0][0]} ${height - padding.bottom} Z`
  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="近30日检测趋势折线图">
        <defs>
          <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity=".35" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="trendLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((line) => {
          const y = padding.top + (line / 3) * (height - padding.top - padding.bottom)
          return <line key={line} x1={padding.left} y1={y} x2={width - padding.right} y2={y} className="chart-gridline" />
        })}
        {[0, 400, 800, 1200].map((value) => {
          const y = padding.top + (1 - value / max) * (height - padding.top - padding.bottom)
          return <text key={value} x={padding.left - 10} y={y + 4} textAnchor="end" className="chart-label">{value}</text>
        })}
        <path d={area} fill="url(#trendArea)" />
        <path d={path} fill="none" stroke="url(#trendLine)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        {coords.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill="#07101f" stroke="#60a5fa" strokeWidth="2" />)}
        {trendData.labels.map((label, i) => {
          if (i % 2 !== 0 && i !== trendData.labels.length - 1) return null
          const x = padding.left + (i / (trendData.values.length - 1)) * (width - padding.left - padding.right)
          return <text key={label} x={x} y={height - 12} textAnchor="middle" className="chart-label">{label}</text>
        })}
      </svg>
    </div>
  )
}

function RiskDonut() {
  return (
    <div className="risk-donut-wrap">
      <div className="risk-donut" aria-label="风险分布：高风险12%，中风险11.8%，低风险76.2%">
        <div className="donut-center"><strong>23.8%</strong><span>中高风险</span></div>
      </div>
      <div className="donut-legend">
        <div><i className="dot-low" /><span>低风险</span><b>76.2%</b></div>
        <div><i className="dot-mid" /><span>中风险</span><b>11.8%</b></div>
        <div><i className="dot-high" /><span>高风险</span><b>12.0%</b></div>
      </div>
    </div>
  )
}

function Dashboard() {
  return (
    <section className="dashboard-section" id="dashboard">
      <div className="section-shell">
        <div className="section-heading dashboard-heading" data-reveal>
          <div>
            <span className="eyebrow"><BarChart3 size={14} />数据统计看板</span>
            <h2>运行数据一屏掌握，<br />让风险趋势清晰可见</h2>
          </div>
          <div className="dashboard-period"><span /><b>数据已同步</b><small>更新于 2 分钟前</small></div>
        </div>

        <div className="stats-grid">
          {statCards.map(({ label, value, unit, change, icon: Icon, tone, points }, i) => (
            <article className={`stat-card tone-${tone}`} key={label} data-reveal style={{ '--delay': `${i * 80}ms` }}>
              <div className="stat-top"><span><Icon size={18} /></span><small>近30日</small></div>
              <p>{label}</p>
              <div className="stat-value"><strong>{value}</strong><span>{unit}</span></div>
              <div className="stat-bottom"><em className={change.startsWith('-') ? 'down' : ''}>{change.startsWith('+') || change.startsWith('-') ? <TrendingUp size={12} /> : <Activity size={12} />}{change}</em><Sparkline points={points} tone={tone} /></div>
            </article>
          ))}
        </div>

        <div className="charts-grid">
          <article className="chart-card main-chart" data-reveal>
            <div className="chart-head">
              <div><strong>检测量与预警趋势</strong><small>近 30 日 · 单位：张</small></div>
              <div className="chart-legend"><span className="legend-blue" />检测图像 <span className="legend-orange" />风险预警</div>
            </div>
            <TrendChart />
          </article>
          <article className="chart-card distribution-card" data-reveal>
            <div className="chart-head">
              <div><strong>风险等级分布</strong><small>基于近 30 日预警样本</small></div>
              <button aria-label="查看更多"><ArrowRight size={15} /></button>
            </div>
            <RiskDonut />
          </article>
        </div>
      </div>
    </section>
  )
}

function About() {
  const steps = [
    { icon: ImageIcon, title: '热成像输入', text: '获取温度矩阵与红外图像' },
    { icon: Cpu, title: 'YOLO 检测', text: '定位火焰、烟雾与异常热源' },
    { icon: Thermometer, title: '温度分析', text: '估算峰值温度与热区面积' },
    { icon: ShieldAlert, title: '风险预警', text: '输出风险等级与处置建议' },
  ]
  return (
    <section className="about-section" id="about">
      <div className="about-glow" />
      <div className="section-shell">
        <div className="about-layout">
          <div className="about-copy" data-reveal>
            <span className="eyebrow"><Layers3 size={14} />项目技术说明</span>
            <h2>让AI成为火警监测网警，<br />让隐患在灾害发生前被看见</h2>
            <p>系统以热成像画面为基础，通过 YOLO 目标检测和温度轮廓、扩散梯度、持续特征融合分析，区分正常热源与火灾隐患，并在明火、烟雾出现前完成灾前分级预警。</p>
            <div className="tech-tags"><span>YOLO 目标检测</span><span>热成像温度分析</span><span>OpenCV 图像处理</span><span>多级风险模型</span><span>灾前预警</span><span>低误报率</span><span>轻量部署</span></div>
            <div className="tech-highlight">
              <div className="highlight-icon"><Database size={22} /></div>
              <div><strong>数据驱动迭代</strong><p>持续采集训练样本与误报案例，优化模型在不同场景下的鲁棒性。</p></div>
            </div>
          </div>

          <div className="workflow-panel" data-reveal>
            <div className="workflow-head"><span>处理流程</span><small>智能分析流程</small></div>
            {steps.map(({ icon: Icon, title, text }, i) => (
              <div className="workflow-step" key={title}>
                <div className="workflow-icon"><Icon size={19} /></div>
                <div><strong>{title}</strong><p>{text}</p></div>
                <span className="workflow-index">0{i + 1}</span>
                {i < steps.length - 1 && <i className="workflow-line" />}
              </div>
            ))}
          </div>
        </div>

        <div className="disclaimer" data-reveal>
          <div><ShieldCheck size={20} /></div>
          <p><strong>科研声明</strong>本系统为科研演示原型，不替代专业消防检测设备。实际部署前需完成现场标定、消防合规评估与专业模型验证。</p>
          <span>研发验证阶段</span>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <div className="section-shell footer-inner">
        <Logo />
        <div className="footer-meta">
          <span><Users size={15} />项目团队：智感安全科研小组</span>
          <span>© 2026 AI 热感火警风险检测系统</span>
          <a href="./mobile-install.html">手机安装</a>
        </div>
        <a href="#home" className="to-top">返回顶部 <ArrowRight size={14} /></a>
      </div>
    </footer>
  )
}

export default function App() {
  useReveal()
  return (
    <div className="app">
      <TopNav />
      <main>
        <Hero />
        <Features />
        <DetectionSection />
        <Dashboard />
        <About />
      </main>
      <Footer />
    </div>
  )
}
