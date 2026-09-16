// 热感哨兵 · 用户端
// 设计参考 iOS 自带「指南针」：单屏、一个大表盘、读数在表盘正中、几乎没有卡片与按钮。
// 全部信息压缩成三件事：往哪个方向走、还有多远、走哪条楼梯。

import { useEffect, useMemo, useRef, useState } from 'react'
import { BUILDING, positionNodeId } from '../mobile/building.js'
// 注意：本组件内部也有个变量叫 planRoute（本层逃生路线图），导入必须另起名字，否则整段函数作用域被遮蔽
import { planRoute as computeRoute } from '../mobile/evacuation.js'
import ArNavigator from './ArNavigator.jsx'
import MoreSheet from './MoreSheet.jsx'
import useGeoLocation from './useGeoLocation.js'
import { formatMeters } from './geo.js'
import { aiCommand, readAiSettings, saveAiSettings } from '../shared/aiClient.js'
import { buildPlanRoute, currentStep, listPlans } from './floorplan.js'
import {
  answerQuestion,
  buildAdvice,
  createDialogueState,
  nextQuestion,
  progressOf,
  saveUserStatus,
  summarizeForRescue,
} from './binaryDialogue.js'
import { createEvent, fireFromEvent, sharedEventBus } from '../shared/eventBus.js'
import OfflineLink from './OfflineLink.jsx'
import ScanSheet from './ScanSheet.jsx'
import {
  isAutoJoinEnabled,
  readAreaChannels,
  resolveAreaChannel,
} from '../shared/geoChannels.js'
import { readCloudChannel, saveCloudChannel } from '../shared/eventBus.js'
// 所有传感器输入（信标定位、火情、热像、朝向、设置）统一从这一层订阅
import {
  KEYS,
  readHazardDetail,
  readHazardSources,
  needsOrientationPermission,
  readFire,
  readSettings,
  readTelemetry,
  requestOrientationPermission,
  resolvePosition,
  saveManualPosition,
  subscribe,
  subscribeOrientation,
  supportsOrientation,
} from './sensors.js'
// 报警引擎与系统端共用同一套 Web Audio 警笛/播报/震动
import {
  ALARM_VIBRATION_INTERVAL,
  isAudioUnlocked,
  speak,
  startSiren,
  stopSiren,
  stopSpeak,
  stopVibrate,
  supportsVibration,
  unlockAudio,
  vibrateAlarm,
} from '../mobile/alarm.js'

const FIRE_KEY = KEYS.fire

const CARDINALS = [
  { short: 'N', label: '北' },
  { short: 'NE', label: '东北' },
  { short: 'E', label: '东' },
  { short: 'SE', label: '东南' },
  { short: 'S', label: '南' },
  { short: 'SW', label: '西南' },
  { short: 'W', label: '西' },
  { short: 'NW', label: '西北' },
]

const SPOTS = [
  { id: 'A', label: 'A 梯' },
  { id: 'C', label: '走廊' },
  { id: 'B', label: 'B 梯' },
]

// 平面图里 x 向东、y 向南，正北为 -y
function bearingBetween(from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return (Math.atan2(dx, -dy) * 180) / Math.PI
}

function normalize(deg) {
  return (deg + 360) % 360
}

function cardinalOf(deg) {
  return CARDINALS[Math.round(normalize(deg) / 45) % 8]
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export default function UserApp() {
  const [position, setPosition] = useState(() => resolvePosition())
  const [fire, setFire] = useState(() => readFire())
  const [telemetry, setTelemetry] = useState(() => readTelemetry())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [sheetOpen, setSheetOpen] = useState(false)
  // north = 固定指北；device = 跟随手机朝向。不需要授权（非 iOS）时默认跟随，方向指示才"实时"
  const [dialMode, setDialMode] = useState(() => (supportsOrientation() && !needsOrientationPermission() ? 'device' : 'north'))
  const [deviceHeading, setDeviceHeading] = useState(null)
  const [hint, setHint] = useState('')
  const [arOpen, setArOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  // GPS：按需开启，只在本机使用；室内楼层仍以信标或手动选点为准
  const gps = useGeoLocation()
  // 逃生路线图与 AI 指挥（路线图存在手机本地，AI 接口可插拔，无网络时用规则引擎）
  const [plans, setPlans] = useState([])
  const [activePlanId, setActivePlanId] = useState(null)
  const [aiSettings, setAiSettings] = useState(() => readAiSettings())
  const [aiResult, setAiResult] = useState(null)
  // 起火阶段：二元问答（是 / 否），答案既改当前指引，也上传给救援端
  const [dialogue, setDialogue] = useState(() => createDialogueState())
  // 收到的火警通报（来自系统端：局域网中继自动送达，或扫离线码人工导入）
  const [linkNotice, setLinkNotice] = useState('')
  const [linkReported, setLinkReported] = useState('')
  // 位置自动加入：GPS 落在某个区域范围内时，自动订阅该区域的警报频道
  const [areaJoin, setAreaJoin] = useState(null)
  // 声音/播报/震动设置由系统端维护，用户端跟随，避免两边不一致
  const [settings, setSettings] = useState(() => readSettings())
  const [audioReady, setAudioReady] = useState(() => isAudioUnlocked())
  const [sirenOn, setSirenOn] = useState(false)
  const [muted, setMuted] = useState(false)
  const sheetTitleRef = useRef(null)

  // 位置（信标优先，回退手动）、火情、设置，全部通过传感器层订阅
  useEffect(() => {
    const offPosition = subscribe([KEYS.position, KEYS.beacon], () => setPosition(resolvePosition()))
    const offHazard = subscribe([KEYS.fire], () => setFire(readFire()))
    const offSettings = subscribe([KEYS.settings], () => setSettings(readSettings()))
    const offTelemetry = subscribe([KEYS.telemetry], () => setTelemetry(readTelemetry()))
    return () => {
      offPosition()
      offHazard()
      offSettings()
      offTelemetry()
    }
  }, [])

  // 心跳：火警时每秒重算（烟气扩散会改变路线），平时两秒刷新一次实时状态
  useEffect(() => {
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), fire ? 1000 : 2000)
    return () => window.clearInterval(timer)
  }, [fire])

  // 收到系统端事件：火警 / 解除 / 通报。局域网中继自动送达；断网时由「离线联通」扫码导入。
  const applyIncomingEvent = (event) => {
    if (!event?.kind) return false
    if (event.kind === 'clear') {
      try {
        localStorage.removeItem(KEYS.fire)
      } catch {}
      setFire(null)
      setLinkNotice('系统端已解除警报')
      return true
    }
    const nextFire = fireFromEvent(event)
    if (nextFire) {
      try {
        localStorage.setItem(KEYS.fire, JSON.stringify(nextFire))
      } catch {}
      setFire(nextFire)
    }
    const notice = String(event.payload?.notice ?? event.payload?.text ?? '').slice(0, 160)
    const floorText = event.payload?.floor ? `${event.payload.floor} 楼` : '本层'
    setLinkNotice(notice || `${floorText}发生火情，按指引撤离`)
    return true
  }

  useEffect(() => {
    const bus = sharedEventBus()
    bus.start()
    const unsubscribe = bus.onEvent((event) => {
      if (event.kind === 'fire' || event.kind === 'notice' || event.kind === 'clear') applyIncomingEvent(event)
    })
    return () => unsubscribe()
    // applyIncomingEvent 依赖 setState，闭包安全；这里只需订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 用户端上报（火源 / 求助）：同时写本机状态并发布到事件总线，系统端能收到
  const publishUserReport = async (text) => {
    const safeText = String(text ?? '').trim() || '用户上报火源或异常'
    const payload = { floor: position.floor, spot: position.spot, text: safeText }
    const finalEvent = createEvent('report', payload, { from: 'user' })
    await sharedEventBus().publish(finalEvent)
    setLinkReported(safeText)
    window.setTimeout(() => setLinkReported(''), 3000)
    return finalEvent
  }

  // 位置自动加入：拿到 GPS 后判断是否在某个区域范围内；在范围内且用户没有手动设过频道，
  // 就自动订阅该区域的警报频道 —— 用户只需要"扫码 + 允许定位"，不用填任何东西。
  useEffect(() => {
    if (!isAutoJoinEnabled()) return
    if (gps.status !== 'active' || !gps.location) return
    const match = resolveAreaChannel(gps.location.lat, gps.location.lon, readAreaChannels())
    if (!match?.area?.channel) {
      setAreaJoin(null)
      return
    }
    setAreaJoin({
      area: match.area,
      distanceMeters: match.distanceMeters,
      channel: match.area.channel,
    })
    const current = readCloudChannel()
    if (current === match.area.channel) return
    if (current) return // 用户手动配置过频道就尊重用户选择
    saveCloudChannel(match.area.channel)
    sharedEventBus().stop()
    window.location.reload()
  }, [gps.status, gps.location])

  // 手机朝向：订阅罗盘/IMU，方向指示随真实朝向实时更新
  useEffect(() => {
    if (dialMode !== 'device') return undefined
    return subscribeOrientation(({ heading }) => {
      if (heading != null) setDeviceHeading(heading)
    })
  }, [dialMode])

  // 浏览器要求音频必须由用户手势解锁：首次触摸/点击/按键时静默解锁
  useEffect(() => {
    if (audioReady) return undefined
    const unlock = () => {
      unlockAudio().then((ok) => { if (ok) setAudioReady(true) })
    }
    const options = { once: true, passive: true }
    window.addEventListener('pointerdown', unlock, options)
    window.addEventListener('touchstart', unlock, options)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('touchstart', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [audioReady])

  // 鸣笛（静音后只保留视觉警报）
  useEffect(() => {
    if (!fire || muted || !audioReady || !settings.sound) {
      setSirenOn(false)
      return undefined
    }
    setSirenOn(Boolean(startSiren(fire.mode === 'drill' ? 'drill' : 'normal')))
    return () => {
      stopSiren()
      setSirenOn(false)
    }
  }, [fire, muted, audioReady, settings.sound])

  // 语音播报
  useEffect(() => {
    if (!fire || muted || !audioReady || !settings.voice) return undefined
    const say = () => speak(fire.mode === 'drill'
      ? '这是一次火警演练，请沿逃生路线离开'
      : '检测到火警，请立即沿逃生路线撤离，不要搭乘电梯')
    say()
    const timer = window.setInterval(say, 9000)
    return () => {
      window.clearInterval(timer)
      stopSpeak()
    }
  }, [fire, muted, audioReady, settings.voice])

  // 震动（iOS Safari 不支持，函数内部会自行判断）
  useEffect(() => {
    if (!fire || muted || !settings.vibrate || !supportsVibration()) return undefined
    vibrateAlarm()
    const timer = window.setInterval(vibrateAlarm, ALARM_VIBRATION_INTERVAL)
    return () => {
      window.clearInterval(timer)
      stopVibrate()
    }
  }, [fire, muted, settings.vibrate])

  // 报警结束时解除静音，下次报警照常鸣响
  useEffect(() => {
    if (!fire) setMuted(false)
  }, [fire])

  // 音频还没解锁就报警时，提示用户点一下屏幕
  useEffect(() => {
    if (!fire || audioReady || !settings.sound) return undefined
    setHint('点击屏幕以启用报警声音')
    return () => setHint('')
  }, [fire, audioReady, settings.sound])

  // 位置弹层：打开时把焦点交给标题，Esc 可关闭
  useEffect(() => {
    if (sheetOpen) sheetTitleRef.current?.focus()
  }, [sheetOpen])

  // 载入本机保存的逃生路线图（IndexedDB）
  useEffect(() => {
    let cancelled = false
    listPlans()
      .then((records) => {
        if (cancelled) return
        setPlans(records)
        setActivePlanId((current) => current ?? records.find((plan) => plan.floor === position.floor)?.id ?? records[0]?.id ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [position.floor])

  useEffect(() => {
    if (!sheetOpen) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSheetOpen(false)
      if (event.key !== 'Tab') return
      // 弹层是模态的：Tab 只在弹层内部循环，不会跑到背后的按钮上
      const sheet = sheetTitleRef.current?.closest('.position-sheet')
      if (!sheet) return
      const focusables = [...sheet.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('disabled'))
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === sheetTitleRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sheetOpen])

  const elapsedSec = fire ? Math.max(0, (nowMs - fire.startedAt) / 1000) : 0
  // 多传感器共同定位：系统端判定的火源 + 热像遥测（经聚类与图上估计，避免"一个火场算成多处")
  const hazard = useMemo(
    () => readHazardDetail({ fire, telemetry, thresholds: settings, nowMs }),
    [fire, telemetry, settings, nowMs],
  )
  const hazardSources = hazard.sources

  // 给用户看的一句话：火源估计 + 不确定度 + 参与判定的传感器数
  const sensorInfo = useMemo(() => {
    const estimates = hazard.estimates ?? []
    if (estimates.length) {
      const top = estimates[0]
      const range = top.uncertaintyHops <= 0 ? '位置明确' : `±${top.uncertaintyHops} 层内`
      const more = estimates.length > 1 ? `（共 ${estimates.length} 处）` : ''
      return `火源估计 ${top.label}${more} · ${range} · 置信度 ${top.confidence.toFixed(2)} · ${top.contributors.length} 个传感器共同判定`
    }
    const watch = hazard.watch ?? []
    if (watch.length) {
      const top = watch.reduce((best, item) => (item.temp > (best?.temp ?? -Infinity) ? item : best), null)
      const floor = BUILDING.nodes[top.nodeId]?.floor ?? position.floor
      return `观察到升温：${floor} 楼 ${Number(top.temp).toFixed(0)}°C（未达报警阈值）`
    }
    return null
  }, [hazard, position.floor])
  const route = useMemo(
    () => computeRoute({ startId: positionNodeId(position.floor, position.spot), fire: hazardSources, elapsedSec }),
    [position.floor, position.spot, hazardSources, elapsedSec],
  )

  const sourceCount = route?.originCount ?? hazardSources.length
  const originFloors = [...new Set((route?.originIds || []).map((id) => BUILDING.nodes[id]?.floor).filter(Boolean))]

  const startNode = BUILDING.nodes[route?.startId] || BUILDING.nodes[positionNodeId(position.floor, position.spot)]
  const nextNodeId = route?.ok ? route.path[1] : null
  const nextNode = nextNodeId ? BUILDING.nodes[nextNodeId] : null
  const targetNode = nextNode || (route?.ok ? BUILDING.nodes[route.exitId] : null)

  const bearing = startNode && targetNode ? normalize(bearingBetween(startNode, targetNode)) : 0
  const cardinal = cardinalOf(bearing)
  const dialRotation = dialMode === 'device' && deviceHeading != null ? -deviceHeading : 0
  // 逃生路线图：本层有图且处于火警时优先按图指引（图上方朝向可在保存时校正）
  const activePlan = useMemo(
    () => plans.find((plan) => plan.id === activePlanId)
      ?? plans.find((plan) => plan.floor === position.floor)
      ?? null,
    [plans, activePlanId, position.floor],
  )
  const planRoute = useMemo(
    () => (fire && activePlan ? buildPlanRoute(activePlan) : null),
    [fire, activePlan],
  )
  const planStep = planRoute ? currentStep(planRoute, null) : null
  const planRemaining = planRoute
    ? planRoute.instructions.reduce((sum, step) => sum + step.meters, 0)
    : 0
  const dialBearing = planStep ? planStep.compassBearing : bearing
  const dialTargetLabel = planRoute ? planRoute.exitLabel : (route?.ok ? route.exitLabel : '最近安全出口')
  const dialRemaining = planRoute ? planRemaining : (route?.ok ? route.meters : null)

  // 二元问答：当前问题、进度、由答案推出的指引
  const dialogueQuestion = fire && !dialogue.done ? nextQuestion(dialogue) : null
  const dialogueProgress = progressOf(dialogue)
  const dialogueAdvice = fire ? buildAdvice(dialogue, {
    routeOk: Boolean(route?.ok || planRoute),
    exitLabel: dialTargetLabel,
    meters: dialRemaining,
  }) : null

  // 起火时重置问答；一旦开始回答就把现况同步给系统端（同一浏览器里救援端能立刻看到）
  useEffect(() => {
    if (!fire) {
      setDialogue(createDialogueState())
      return
    }
    setDialogue(createDialogueState())
  }, [fire?.startedAt, fire?.nodeId])

  useEffect(() => {
    if (!fire || !dialogue.order?.length) return
    const status = summarizeForRescue(dialogue, {
      floor: position.floor,
      spot: position.spot,
      routeOk: Boolean(route?.ok || planRoute),
      exitLabel: dialTargetLabel,
      meters: dialRemaining,
    })
    saveUserStatus(status)
    // 同步给系统端：救援端据此知道"哪一层、哪个位置有人需要帮助"
    sharedEventBus().publish(createEvent('status', status, { from: 'user' }))
  }, [dialogue, fire, position.floor, position.spot, route?.ok, planRoute, dialTargetLabel, dialRemaining])

  // AI 指挥：优先本地大模型，失败或未配置时回落到本机规则引擎（保证无网络也有指令）
  useEffect(() => {
    if (!fire) {
      setAiResult(null)
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      aiCommand({
        fire,
        route: route ? { ok: route.ok, meters: route.meters, exitLabel: route.exitLabel, reason: route.reason } : null,
        hazard: hazard ? { estimates: hazard.estimates ?? [] } : null,
        crowd: null,
        position,
        gps: { status: gps.status, location: gps.location ?? null },
        plan: planRoute ? { name: activePlan?.name, route: planRoute } : null,
        // 感知来源：装了 YOLO 的现场，决策文案里会带上视觉证据
        perception: aiSettings.visionUrl ? { source: 'yolo' } : null,
      }, aiSettings).then((result) => {
        if (!cancelled) setAiResult(result)
      })
    }, 700)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fire, route?.ok, route?.meters, route?.exitLabel, gps.status, planRoute, aiSettings, position.floor, position.spot, hazard])

  const needleRotation = dialBearing - dialRotation
  // 接近度（0 远 → 1 就在跟前），用于放大箭头与提示状态；参考 Apple「查找附近」的距离+方向表达
  const proximity = route?.ok ? Math.max(0, Math.min(1, 1 - route.meters / 120)) : 0
  const atExit = Boolean(route?.ok && route.meters <= 6)
  const proximityText = !route?.ok ? '' : atExit ? '就在这里' : proximity > 0.62 ? '就在附近' : proximity > 0.3 ? '接近中' : '按箭头前进'

  const nextStep = route?.ok ? route.steps.find((step) => step.icon !== 'pin') : null
  const distanceToNext = route?.ok && nextNode
    ? route.path.length > 1
      ? (BUILDING.adjacency[route.path[0]].find((edge) => edge.to === route.path[1])?.meters || 0)
      : 0
    : 0

  // 剩余楼层：以当前所在层与出口所在层的差值为准（下行取负）
  const startFloor = BUILDING.nodes[route?.startId]?.floor ?? position.floor
  const exitFloor = route?.ok ? (BUILDING.nodes[route.exitId]?.floor ?? startFloor) : startFloor
  const floorDelta = exitFloor - startFloor
  const remainingFloors = route?.ok
    ? floorDelta === 0
      ? '已在本层'
      : `${Math.abs(floorDelta)} 层 · ${floorDelta < 0 ? '下行' : '上行'}`
    : '—'

  // 位置来源：信标实时定位 / 手动选点，直接显示出来便于判断导航精度
  const positionSource = position.source === 'beacon'
    ? `信标定位${position.accuracy ? ` ±${position.accuracy} 米` : ''}`
    : '手动选点'

  // 给读屏软件的一句话状态：只随路线变化，不随秒数跳动，避免每秒重复播报
  const statusText = route?.ok
    ? `${fire ? `火警，请立即撤离。${sourceCount > 1 ? `现场 ${sourceCount} 处火源。` : ''}${hazard.estimates?.length ? `多传感器定位结果：火源估计 ${hazard.estimates[0].label}，不确定范围 ±${hazard.estimates[0].uncertaintyHops} 层内。` : ''}` : '当前无火警。'}撤离至 ${route.exitLabel}，${Math.round(route.meters)} 米，约 ${formatDuration(route.seconds)}，${floorDelta === 0 ? '已在本层' : `剩余 ${Math.abs(floorDelta)} 层，${floorDelta < 0 ? '下行' : '上行'}`}。`
    : `${fire ? '火警。' : ''}${route?.reason || '正在定位当前位置'}`
  const dialLabel = route?.ok
    ? `撤离方向表盘：目标${cardinal.label}方向，距离 ${Math.round(route.meters)} 米`
    : '撤离方向表盘：通道受阻'

  // GPS 状态文案：精度、校园内外判断与最近出口距离（室内楼层仍以信标/手动为准）
  const gpsText = useMemo(() => {
    if (gps.status === 'active' && gps.location) {
      const near = gps.location.nearestExit
      const where = gps.location.inside ? '校园内' : '校园外'
      const nearest = near ? ` · 距${near.point.name} ${formatMeters(near.meters)}` : ''
      return `GPS 定位 ±${Math.round(gps.accuracy ?? 0)} 米 · ${where}${nearest}`
    }
    if (gps.status === 'requesting') return '正在获取 GPS 定位…'
    if (gps.status === 'idle') return gps.supported ? 'GPS 未开启，可在「我的位置」里打开' : '本机不支持 GPS 定位'
    return gps.error || '定位暂不可用'
  }, [gps.status, gps.location, gps.accuracy, gps.error, gps.supported])



  const requestCompass = async () => {
    if (dialMode === 'device') {
      setDialMode('north')
      return
    }
    if (!supportsOrientation()) {
      setHint('该设备不支持方向感应，已保持固定指北')
      window.setTimeout(() => setHint(''), 2600)
      return
    }
    if (needsOrientationPermission() && !(await requestOrientationPermission())) {
      setHint('未获得方向权限，已保持固定指北')
      window.setTimeout(() => setHint(''), 2600)
      return
    }
    setDialMode('device')
  }

  // 手动选点（演示用）：写入手动位置键，信标不可用时即以此为准
  const applyManualPosition = (patch) => {
    const next = { floor: patch.floor ?? position.floor, spot: patch.spot ?? position.spot }
    saveManualPosition(next)
    setPosition(resolvePosition())
  }

  const toggleDrill = () => {
    if (fire) {
      localStorage.removeItem(FIRE_KEY)
      setFire(null)
      return
    }
    const startedAt = Date.now()
    localStorage.setItem(FIRE_KEY, JSON.stringify({ nodeId: `C${position.floor}`, floor: position.floor, startedAt, mode: 'drill' }))
    setFire({ nodeId: `C${position.floor}`, floor: position.floor, startedAt, mode: 'drill' })
  }

  return (
    <div
      className={`compass-app ${fire ? 'is-alert' : ''}`}
      data-audio={audioReady ? 'ready' : 'locked'}
      data-siren={sirenOn ? 'on' : 'off'}
      data-muted={muted ? 'true' : 'false'}
    >
      {fire && (
        <button
          type="button"
          className="alert-strip"
          aria-pressed={muted}
          onClick={() => setMuted((current) => !current)}
        >
          <span>{fire.mode === 'drill' ? '火警演练 · 立即撤离' : '火警 · 立即撤离'}</span>
          <em>
            {sourceCount > 1
              ? `${originFloors.join(' / ')} 楼共 ${sourceCount} 处火源`
              : `${originFloors[0] ?? BUILDING.nodes[fire.nodeId]?.floor ?? position.floor} 楼起火`}
            {' · '}
            {muted ? '已静音，点此恢复鸣响' : '点此静音'}
          </em>
        </button>
      )}

      <p className="sr-only" role="status" aria-live={fire ? 'assertive' : 'polite'} aria-atomic="true">
        {statusText}
      </p>

      <main className="compass-stage">
        <div className="dial-wrap">
          <CompassDial
            rotation={dialRotation}
            needle={needleRotation}
            alert={Boolean(fire)}
            label={dialLabel}
            proximity={proximity}
            atExit={atExit}
          />

          <div className="dial-center">
            <div className="dial-caption">
              {route?.ok || planRoute ? `${cardinalOf(dialBearing).label} · ${Math.round(dialBearing)}°` : '通道受阻'}
            </div>

            {route?.ok ? (
              <>
                <div className={`dial-distance ${fire ? 'is-alert' : ''}`}>
                  <span className="distance-value">{Math.round(dialRemaining ?? 0)}</span>
                  <span className="distance-unit">米</span>
                </div>
                <div className="dial-time">约 {formatDuration(route.seconds)}</div>
                {proximityText && <div className={`dial-proximity ${atExit ? 'is-here' : ''}`}>{proximityText}</div>}
              </>
            ) : (
              <div className="dial-distance is-blocked">
                <span className="distance-value">受阻</span>
              </div>
            )}
          </div>
        </div>

        <div className="stage-side">
          <div className="stage-readouts" role="list">
            {route?.ok ? (
              <>
                <div className="readout" role="listitem">
                  <span>{fire ? '撤离至' : '最近出口'}</span>
                  <strong>{route.exitLabel}</strong>
                </div>
                <div className="readout-sep" aria-hidden="true" />
                <div className="readout" role="listitem">
                  <span>剩余楼层</span>
                  <strong>{remainingFloors}</strong>
                </div>
              </>
            ) : (
              <div className="readout readout-wide" role="listitem">
                <span>提示</span>
                <strong>{route?.reason || '等待定位'}</strong>
              </div>
            )}
          </div>

          <div className="stage-note">
            <span className={`live-dot ${route?.ok ? 'is-live' : ''}`} aria-hidden="true" />
            <span>
              {fire
                ? `实时 · ${sourceCount > 1 ? `${sourceCount} 处火源 · ` : ''}距起火点 ${Math.round(elapsedSec)} 秒，路线每秒重算`
                : `${route?.ok ? '实时 · ' : ''}${positionSource} · ${position.floor} 楼${SPOTS.find((item) => item.id === position.spot)?.label} · ${route?.ok ? `${Math.round(distanceToNext)} 米后${nextStep?.icon === 'stair' ? '进楼梯' : '到下一个路口'}` : '等待定位'}`}
            </span>
          </div>

          {sensorInfo && <div className="sensor-note">{sensorInfo}</div>}

          {linkNotice && (
            <div className="link-note">
              <span className="link-tag">火警通报 · 来自系统端</span>
              <span>{linkNotice}</span>
            </div>
          )}

          {linkReported && (
            <div className="link-note is-report">
              <span className="link-tag">已上报系统端</span>
              <span>{linkReported}</span>
            </div>
          )}

          {areaJoin && (
            <div className="link-note is-area">
              <span className="link-tag">已自动加入区域警报</span>
              <span>
                {areaJoin.area.label}（距中心约 {areaJoin.distanceMeters} 米）· 该区域的火警会直接推到这个手机
              </span>
            </div>
          )}

          {planRoute && (
            <div className="plan-note">
              <span className="plan-tag">按路线图撤离</span>
              <span>
                {activePlan?.name ?? '本层路线图'}
                {activePlan?.ai ? '（本地模型已复核）' : ''}
                {planRoute.exitLabel ? ` → ${planRoute.exitLabel}` : ''} · {planStep?.text ?? '等待路线'}
                {' · '}全程约 {Math.round(planRoute.totalMeters)} 米
              </span>
            </div>
          )}

          {aiResult && (
            <div className={`ai-note ${aiResult.source === 'local-model' ? 'is-model' : ''}`}>
              <span className="ai-tag">
                AI 指挥 · {aiResult.source === 'local-model' ? '本地模型' : '本机规则'}
              </span>
              <span>{aiResult.summary}</span>
              <strong>{aiResult.action}</strong>
              {aiResult.instruction && <em>{aiResult.instruction}</em>}
            </div>
          )}

          {fire && (
            <div className={`ask-card tone-${dialogueAdvice?.tone ?? 'caution'}`}>
              <div className="ask-head">
                <span className="ask-tag">AI 现场问答</span>
                <small>{dialogueProgress.answered}/{dialogueProgress.total} 已回答</small>
              </div>
              <div className="ask-bar"><i style={{ width: `${dialogueProgress.ratio * 100}%` }} /></div>
              {dialogueQuestion ? (
                <>
                  <p className="ask-question">{dialogueQuestion.text}</p>
                  <p className="ask-hint">{dialogueQuestion.hint}</p>
                  <div className="ask-buttons">
                    <button
                      type="button"
                      className="ask-yes"
                      onClick={() => setDialogue((current) => answerQuestion(current, dialogueQuestion.id, 'yes'))}
                    >
                      是 · {dialogueQuestion.yes}
                    </button>
                    <button
                      type="button"
                      className="ask-no"
                      onClick={() => setDialogue((current) => answerQuestion(current, dialogueQuestion.id, 'no'))}
                    >
                      否 · {dialogueQuestion.no}
                    </button>
                  </div>
                </>
              ) : (
                <p className="ask-advice">{dialogueAdvice?.text}</p>
              )}
              {dialogue.order?.length > 0 && (
                <div className="ask-foot">
                  <span>{dialogueAdvice?.text}</span>
                  {dialogueAdvice?.needsHelp && <em>已把你的位置与情况同步给救援端</em>}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="compass-tools">
        <button type="button" className="tool-scan" onClick={() => setScanOpen(true)}>演练</button>
        <button type="button" onClick={() => setSheetOpen(true)}>我的位置</button>
        <button type="button" className="tool-ar" onClick={() => setArOpen(true)}>AR</button>
        <button type="button" onClick={() => setMoreOpen(true)}>更多</button>
        <button
          type="button"
          onClick={requestCompass}
          aria-label={dialMode === 'device' ? '固定指北' : '跟随手机朝向'}
        >
          {dialMode === 'device' ? '指北' : '罗盘'}
        </button>
      </footer>

      {hint && <div className="compass-toast">{hint}</div>}

      {arOpen && (
        <ArNavigator
          route={route}
          fire={fire}
          proximity={proximity}
          atExit={atExit}
          proximityText={proximityText}
          bearing={dialBearing}
          targetLabel={dialTargetLabel}
          remainingFloors={remainingFloors}
          positionSource={positionSource}
          gps={gps}
          onClose={() => setArOpen(false)}
        />
      )}

      {moreOpen && (
        <MoreSheet
          floor={position.floor}
          spot={position.spot}
          aiSettings={aiSettings}
          onAiSettingsChange={(patch) => setAiSettings(saveAiSettings(patch))}
          plans={plans}
          onPlansChange={setPlans}
          activePlanId={activePlanId}
          onActivePlanChange={setActivePlanId}
          nearestExit={dialTargetLabel}
          onImportEvent={applyIncomingEvent}
          onReport={publishUserReport}
          onClose={() => setMoreOpen(false)}
        />
      )}

      {scanOpen && (
        <ScanSheet
          fireActive={Boolean(fire)}
          onClose={() => setScanOpen(false)}
          onJoined={(channel) => {
            setLinkNotice(`已加入系统端演练频道（${channel}）`)
          }}
          onSelfDrill={toggleDrill}
        />
      )}

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <section
            className="position-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="position-sheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <h2 id="position-sheet-title" tabIndex={-1} ref={sheetTitleRef}>我的位置</h2>
            <p>实际部署时由蓝牙信标自动定位，这里用于演示手动选点。</p>
            <div className="floor-row-picker" role="group" aria-label="选择楼层">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((floor) => (
                <button
                  key={floor}
                  type="button"
                  className={position.floor === floor ? 'active' : ''}
                  aria-pressed={position.floor === floor}
                  onClick={() => applyManualPosition({ floor })}
                >
                  {floor}
                </button>
              ))}
            </div>
            <div className="spot-row-picker" role="group" aria-label="选择位置">
              {SPOTS.map((spot) => (
                <button
                  key={spot.id}
                  type="button"
                  className={position.spot === spot.id ? 'active' : ''}
                  aria-pressed={position.spot === spot.id}
                  onClick={() => applyManualPosition({ spot: spot.id })}
                >
                  {spot.label}
                </button>
              ))}
            </div>

            <div className={`gps-block ${gps.status === 'active' ? 'is-live' : ''}`}>
              <div className="gps-head">
                <strong>手机 GPS 定位</strong>
                <span className="gps-state">{gpsText}</span>
              </div>
              <p className="gps-note">
                用于判断你在校园的哪个位置、离最近出口多远。坐标只在本机使用，不上传、不写入本地存储；
                楼内楼层仍以蓝牙信标或手动选点为准。
              </p>
              <button
                type="button"
                className="gps-toggle"
                aria-pressed={gps.status === 'active'}
                disabled={!gps.supported}
                onClick={() => (gps.status === 'active' ? gps.stop() : gps.start())}
              >
                {gps.status === 'active' ? '关闭 GPS 定位' : gps.status === 'requesting' ? '正在获取定位…' : '开启 GPS 定位'}
              </button>
            </div>

            <button className="done-button" type="button" onClick={() => setSheetOpen(false)}>完成</button>
          </section>
        </div>
      )}
    </div>
  )
}

// 表盘：外圈刻度 + 四向字母，中间留给读数，指针指向应走的方向
function CompassDial({ rotation, needle, alert, label, proximity = 0, atExit = false }) {
  const ticks = []
  for (let degree = 0; degree < 360; degree += 5) {
    const major = degree % 45 === 0
    const medium = degree % 15 === 0
    const inner = major ? 86 : medium ? 93 : 97
    const angle = (degree * Math.PI) / 180
    const x1 = 120 + Math.sin(angle) * inner
    const y1 = 120 - Math.cos(angle) * inner
    const x2 = 120 + Math.sin(angle) * 104
    const y2 = 120 - Math.cos(angle) * 104
    ticks.push(
      <line
        key={degree}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className={major ? 'tick tick-major' : medium ? 'tick tick-medium' : 'tick'}
      />,
    )
  }

  return (
    <svg className="compass-dial" viewBox="0 0 240 240" role="img" aria-label={label}>
      <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '120px 120px', transition: 'transform .25s ease-out' }}>
        <circle cx="120" cy="120" r="104" className="dial-ring" />
        {ticks}
        {CARDINALS.filter((item) => item.short.length <= 2 && item.short !== 'NE' && item.short !== 'SE' && item.short !== 'SW' && item.short !== 'NW').map((item) => {
          const index = CARDINALS.indexOf(item)
          const angle = (index * 45 * Math.PI) / 180
          const x = 120 + Math.sin(angle) * 72
          const y = 120 - Math.cos(angle) * 72
          return (
            <text key={item.short} x={x} y={y + 5} className={`dial-letter ${item.short === 'N' ? 'is-north' : ''}`}>
              {item.short}
            </text>
          )
        })}
      </g>
      <g style={{ transform: `rotate(${needle}deg)`, transformOrigin: '120px 120px', transition: 'transform .45s cubic-bezier(.32,.72,0,1)' }}>
        {/* 接近目标时出现的脉冲光环（参考 Apple 查找附近：越近越明显） */}
        <circle
          cx="120"
          cy="120"
          r={62 + 10 * proximity}
          className={atExit ? 'aim-halo is-here' : 'aim-halo'}
          style={{ opacity: 0.12 + 0.5 * proximity }}
        />
        <polygon
          points="120,14 138,64 120,51 102,64"
          className={alert ? 'needle needle-alert' : 'needle'}
        />
        <line x1="120" y1="54" x2="120" y2="104" className={alert ? 'needle-line needle-alert' : 'needle-line'} />
      </g>
      <circle cx="120" cy="120" r="3" className="dial-pin" />
    </svg>
  )
}
