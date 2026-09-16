// AI 的三个工作阶段（对应团队定的部署方向）
//
//   1. prevention 火灾前 · 预防判定：视觉（火焰/烟雾）+ 热像 + 温升趋势联合判定，
//      回答"该不该报警"，并生成给周边居民的一句话现场说明；
//   2. response   起火中 · 逃生与救援：给被困者最优路线 + 二元问答了解现况，
//      并把楼内现况汇总给救援端（配合三维模型定位）；
//   3. aftermath  火灾后 · 生命体征搜索：用红外热像在残余热场里找人体温度特征，
//      辅助后期搜救（由 src/mobile/vitalSigns.js 实现具体算法）。
//
// 本文件只放纯函数与提示词，便于单测；模型调用统一走 src/shared/aiClient.js。

export const AI_PHASES = {
  prevention: {
    id: 'prevention',
    label: '火灾前 · 预防判定',
    short: '预防',
    goal: '判断是否达到报警条件，并把现场情况说明白',
  },
  response: {
    id: 'response',
    label: '起火中 · 逃生与救援',
    short: '处置',
    goal: '给出最优逃生方案，并把楼内现况汇总给救援端',
  },
  aftermath: {
    id: 'aftermath',
    label: '火灾后 · 生命体征搜索',
    short: '搜救',
    goal: '在残余热场中寻找生命体征，辅助后续救援',
  },
}

// ---------------------------------------------------------------- 阶段一：预防判定

export const DEFAULT_FUSION_WEIGHTS = {
  thermalStrong: 0.45,
  thermalTrend: 0.2,
  flame: 0.3,
  smoke: 0.25,
  alarmThreshold: 0.55,
  watchThreshold: 0.3,
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const ratio = (value) => Math.max(0, Math.min(1, num(value)))

// 三路证据融合：热像（绝对值 + 温升速率 + 持续时间）、视觉火焰、烟雾。
// 关键约束：**单一证据不足以报警**（防止热风枪、阳光反射、烟雾机造成误报），
// 至少要有两路独立证据同时成立，或者热像自己满足"超阈值 + 持续 + 快速升温"。
export function fusePreventionSignals(input = {}, options = {}) {
  const weights = { ...DEFAULT_FUSION_WEIGHTS, ...options }
  const thermal = input.thermal ?? {}
  const visual = input.visual ?? {}
  const smoke = input.smoke ?? {}
  const thresholds = input.thresholds ?? {}
  const high = num(thresholds.high, 65)
  const medium = num(thresholds.medium, 45)

  const maxTemp = num(thermal.maxTemp, 0)
  const ror = num(thermal.ror, 0) // °C/分钟
  const sustainedSec = num(thermal.sustainedSec, 0)
  const multiNode = Boolean(thermal.multiNode)
  const flame = ratio(visual.flame)
  const smokeConfidence = ratio(visual.smoke ?? smoke.confidence)
  const smokeDensity = ratio(smoke.density)

  const tempHit = maxTemp >= high
  const tempWarm = maxTemp >= medium
  const fastRise = ror >= 6
  const lasting = sustainedSec >= 8
  const flameSeen = flame >= 0.5
  const smokeSeen = Math.max(smokeConfidence, smokeDensity) >= 0.45

  const thermalStrong = tempHit && (lasting || fastRise)
  const thermalTrend = !thermalStrong && (tempWarm || fastRise)
  const evidenceCount = [thermalStrong, flameSeen, smokeSeen].filter(Boolean).length

  let score = 0
  if (thermalStrong) score += weights.thermalStrong
  if (thermalTrend) score += weights.thermalTrend
  if (flameSeen) score += weights.flame * Math.max(flame, 0.5)
  if (smokeSeen) score += weights.smoke * Math.max(smokeConfidence, smokeDensity, 0.45)
  if (multiNode && thermalStrong) score += 0.08
  // 超阈值 + 持续 + 快速升温：热像自身已经构成完整证据链，补足权重，
  // 这样"没有摄像头、只有热像"的楼栋也能独立报警（多节点投票另加 0.08）
  if (thermalStrong && fastRise && lasting) score += 0.15
  score = Math.min(1, score)

  const reasons = []
  if (tempHit) reasons.push(`最高温 ${maxTemp.toFixed(1)}°C 超过报警阈值 ${high}°C`)
  else if (tempWarm) reasons.push(`最高温 ${maxTemp.toFixed(1)}°C 达关注阈值 ${medium}°C`)
  if (fastRise) reasons.push(`温升速率 ${ror.toFixed(1)}°C/分钟，属快速升温`)
  if (lasting && tempHit) reasons.push(`高温已持续 ${sustainedSec.toFixed(0)} 秒`)
  if (multiNode) reasons.push('多个节点同时上报，可参与投票')
  if (flameSeen) reasons.push(`视觉识别到火焰（置信度 ${(flame * 100).toFixed(0)}%）`)
  if (smokeSeen) reasons.push(`识别到烟雾（置信度 ${(Math.max(smokeConfidence, smokeDensity) * 100).toFixed(0)}%）`)
  if (!reasons.length) reasons.push('温度、温升与视觉均正常')

  // 单一证据不报警：两路证据齐全，或热像自身满足强条件且带趋势
  const enoughEvidence = evidenceCount >= 2
  const thermalAlone = thermalStrong && fastRise && lasting
  // 视觉看到明火是一种"直接证据"：高置信火焰、或火焰+烟雾同时确认，就应该报警，
  // 不能因为热像还没升温（火源离节点远、面积小）就漏报。
  const visualConfirmedFlame = flame >= 0.75
  const twoVisualCues = flame >= 0.6 && Math.max(smokeConfidence, smokeDensity) >= 0.5
  const alarm = visualConfirmedFlame
    || twoVisualCues
    || ((tempHit || flameSeen) && (enoughEvidence || thermalAlone) && score >= weights.alarmThreshold)
  const watch = !alarm && (score >= weights.watchThreshold || tempWarm || smokeSeen || flameSeen)

  const level = alarm ? 'alarm' : watch ? 'watch' : 'normal'
  if (visualConfirmedFlame) reasons.push(`视觉高置信确认明火（${(flame * 100).toFixed(0)}%）`)
  else if (twoVisualCues) reasons.push('视觉同时确认火焰与烟雾（两路独立证据）')
  const missing = []
  if (!flameSeen) missing.push('视觉未确认火焰')
  if (!smokeSeen) missing.push('未识别到烟雾')
  if (!thermalStrong) missing.push('热像未达持续高温')
  if (!enoughEvidence && alarm) missing.push('已由热像趋势单独判定')

  return {
    phase: 'prevention',
    level,
    alarm,
    score: Number(score.toFixed(2)),
    confidence: Number(Math.min(0.98, 0.35 + evidenceCount * 0.2 + (fastRise ? 0.05 : 0)).toFixed(2)),
    evidence: {
      thermal: { maxTemp, ror, sustainedSec, multiNode, tempHit, tempWarm, fastRise, lasting, strong: thermalStrong },
      visual: { flame, flameSeen },
      smoke: { confidence: smokeConfidence, density: smokeDensity, smokeSeen },
      sources: evidenceCount,
    },
    reasons,
    missing,
  }
}

// 给周边居民的通知：只说此刻知道的事，加一句该做什么，不夸大也不含糊
export function buildNeighborNotice(decision, context = {}) {
  const where = context.location || context.building || '本楼'
  const floor = context.floor ? `${context.floor} 楼` : ''
  const place = `${where}${floor ? ` ${floor}` : ''}`
  const temp = decision?.evidence?.thermal?.maxTemp
  const conf = decision?.confidence != null ? `${Math.round(decision.confidence * 100)}%` : null

  if (!decision || decision.level === 'normal') {
    return `【热感哨兵】${place}监测正常，暂无需撤离。如闻到焦糊味请立即告知值班人员。`
  }
  if (decision.level === 'watch') {
    const why = [
      Number.isFinite(temp) ? `检测到局部升温至 ${temp.toFixed(0)}°C` : '检测到升温迹象',
      decision.evidence?.smoke?.smokeSeen ? '伴有烟雾特征' : null,
    ].filter(Boolean).join('，')
    return `【热感哨兵】${place}${why}，正在复核，请周边人员暂时远离该区域、保持通道畅通。`
  }
  const what = [
    Number.isFinite(temp) ? `温度 ${temp.toFixed(0)}°C` : null,
    decision.evidence?.visual?.flameSeen ? '已识别明火' : null,
    decision.evidence?.smoke?.smokeSeen ? '伴有烟雾' : null,
  ].filter(Boolean).join('、')
  return `【热感哨兵】${place}确认火情${what ? `（${what}）` : ''}${conf ? `，判定置信度 ${conf}` : ''}。请立即沿最近的安全出口撤离，不要乘坐电梯，不要返回取物；等待疏散指引的请联系现场负责人。`
}

// ---------------------------------------------------------------- 阶段二：逃生与救援

// 救援端要看的「楼内现况」：把用户端二元问答的结果汇总成一句话
export function summarizeRescueBrief(context = {}) {
  const { fire = null, position = null, crowd = null, blocked = [], userStatus = [] } = context
  const lines = []
  const fireFloors = (fire?.nodes?.length ? fire.nodes : [fire?.nodeId]).filter(Boolean).map((id) => Number(String(id).replace(/\D/g, '')) || null)
  lines.push(fireFloors.length ? `起火层：${[...new Set(fireFloors)].join('、')} 楼` : '起火层：待确认')
  if (position) lines.push(`最近上报位置：${position.floor} 楼 ${position.spot}`)
  if (crowd?.totals) lines.push(`楼内未撤离约 ${crowd.totals.remaining} 人`)
  if (blocked?.length) lines.push(`已封控通道：${blocked.join('、')}`)
  const needingHelp = (userStatus ?? []).filter((item) => item.needsHelp)
  if (needingHelp.length) {
    lines.push(`收到 ${needingHelp.length} 条求助：${needingHelp.slice(0, 3).map((item) => `${item.floor} 楼 ${item.spot}（${item.advice ?? '等待指引'}）`).join('；')}`)
  }
  return lines
}

// ---------------------------------------------------------------- 提示词

const PHASE_SYSTEM_PROMPTS = {
  prevention: [
    '你是校园火灾预警系统的判定助手。输入是热像、视觉与烟雾三路证据的结构化数据。',
    '输出严格的 JSON：{"level":"normal|watch|alarm","summary":"一句话现场情况","action":"一句话该做什么","notice":"给周边居民的通知（30 字内）"}',
    '规则：只有一路证据时要说明不确定，不要因为单点高温就宣布火情；不得编造未提供的传感器数据。',
  ].join('\n'),
  response: [
    '你是校园火灾疏散指挥助手，服务两类人：楼内被困者与救援人员。',
    '输出严格的 JSON：{"summary":"一句话现场态势","action":"一句话撤离或救援决策","instruction":"给楼内人员的一步动作","rescue":"给救援端的一句话（楼层、通道、被困信息）"}',
    '规则：不要编造未提供的楼层与通道；信息不足时明确要求等待下一次更新。',
  ].join('\n'),
  aftermath: [
    '你是灾后搜救辅助助手。输入是红外热像扫描结果，其中已剔除火场余温，只保留人体温度特征区域。',
    '输出严格的 JSON：{"summary":"一句话结论","priority":"优先排查顺序","action":"给救援队的下一步动作","caution":"需要提示的风险"}',
    '规则：生命体征判定只是辅助，必须提示人工复核；没有候选目标时也要给出继续扫描的建议。',
  ].join('\n'),
}

export function buildPhaseMessages(phase, context) {
  const system = PHASE_SYSTEM_PROMPTS[phase] ?? PHASE_SYSTEM_PROMPTS.response
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(context) },
  ]
}
