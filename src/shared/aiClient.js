// AI 指挥接口层（本地优先）
//
// 目标：把"AI 指挥决策"做成可插拔的一层——团队把本地大模型（Ollama / LM Studio / vLLM 等
// OpenAI 兼容端点）部署到现场机器或边缘盒子后，只要在设置里填地址与模型名即可接管；
// 没有网络、没有模型时，自动回落到本机规则引擎，保证紧急情况下一定有可用指令。
//
// 约定：
//   · 只走 OpenAI 兼容的 /chat/completions 与 /models，方便替换任意本地推理服务；
//   · 请求带超时，任何失败都不抛异常，调用方永远拿到结构化结果（带 source 字段）；
//   · 密钥只存在本机 localStorage，不随任何埋点上报。

import { buildNeighborNotice, buildPhaseMessages, fusePreventionSignals } from './aiPhases.js'
import { describeVitalSigns } from './vitalSigns.js'
import {
  getVitalSensor,
  getVisionDetector,
  integrationStatus,
  listExtraProviders,
  readVitalFrame,
  registerProvider,
  registerVitalSensor,
  registerVisionDetector,
  runVisionDetector,
  subscribeIntegrations,
} from './aiHooks.js'
import { readCloudChannel, saveCloudChannel } from './eventBus.js'

export const AI_SETTINGS_KEY = 'thermalGuardAiSettings'

export const AI_PROVIDERS = {
  offline: {
    id: 'offline',
    label: '本机规则引擎（无网络可用）',
    hint: '不调用任何模型，按现场数据直接给出指令',
    baseUrl: '',
    model: '',
  },
  ollama: {
    id: 'ollama',
    label: '本地 Ollama',
    hint: '现场机器上运行 ollama serve，默认端口 11434',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
  },
  lmstudio: {
    id: 'lmstudio',
    label: '本地 LM Studio',
    hint: 'LM Studio 打开 Local Server，默认端口 1234',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-7b-instruct',
  },
  vllm: {
    id: 'vllm',
    label: '本地 vLLM / 自建端点',
    hint: '任何 OpenAI 兼容端点，例如 http://192.168.1.20:8000/v1',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: '',
  },
  custom: {
    id: 'custom',
    label: '自定义端点（云端或自建网关）',
    hint: '任何兼容 OpenAI /chat/completions 的服务：豆包（火山方舟）、DeepSeek、自建网关等，地址与模型名自己填',
    baseUrl: '',
    model: '',
  },
}

// 界面里下拉框用的完整列表：内置预设 + 队友用 registerProvider 注册进来的
export function listAiProviders() {
  return { ...AI_PROVIDERS, ...listExtraProviders() }
}

export function providerPreset(id) {
  const all = listAiProviders()
  return all[id] ?? all.custom ?? AI_PROVIDERS.custom
}

export const DEFAULT_AI_SETTINGS = {
  provider: 'offline',
  baseUrl: '',
  model: '',
  apiKey: '',
  timeoutMs: 6000,
  // 该本地模型是否支持读图（qwen2.5-vl / llava / minicpm-v 等）。关掉时只发文字摘要，
  // 打开后会把缩小的路线图一并交给本地模型识别——两者都不出本机网络。
  vision: false,
}

function safeParse(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// 队友可以在不改界面的情况下批量配置：把 ai-config.json 放到站点根目录，
// 或在页面里先设置 window.THERMAL_GUARD_AI = {...}。界面里保存过的设置优先级最高。
let externalConfig = null

export function setExternalAiConfig(config) {
  if (!config || typeof config !== 'object') {
    externalConfig = null
    return null
  }
  // 只取认识的字段，配置文件里的注释字段（_readme / _fields 等）不参与合并
  const allowed = ['provider', 'baseUrl', 'model', 'apiKey', 'vision', 'timeoutMs', 'cloudChannel', 'areaChannels']
  const next = {}
  allowed.forEach((key) => {
    if (config[key] !== undefined) next[key] = config[key]
  })
  externalConfig = Object.keys(next).length ? next : null
  return externalConfig
}

export function getExternalAiConfig() {
  return externalConfig ? { ...externalConfig } : null
}

export function readAiSettings() {
  const stored = typeof localStorage === 'undefined' ? {} : (safeParse(localStorage.getItem(AI_SETTINGS_KEY)) ?? {})
  const config = { ...(externalConfig ?? {}), ...stored }
  const preset = providerPreset(config.provider)
  return {
    ...DEFAULT_AI_SETTINGS,
    ...externalConfig,
    ...stored,
    provider: config.provider ?? DEFAULT_AI_SETTINGS.provider,
    baseUrl: config.baseUrl ?? preset.baseUrl,
    model: config.model ?? preset.model,
  }
}

export function saveAiSettings(patch) {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AI_SETTINGS, ...patch }
  const next = { ...readAiSettings(), ...patch }
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next))
  return next
}

// ---------------------------------------------------------------- 启动引导 / 对外接口
//
// 两个页面（用户端、系统端）启动时都会调用一次：
//   1. 读 window.THERMAL_GUARD_AI（脚本注入）；
//   2. 读站点根目录的 ai-config.json（队友可以直接改文件部署）；
//   3. 把 window.ThermalGuardAI 暴露出去，队友可以在控制台或自己的脚本里注册能力。
export async function bootstrapAiConfig() {
  if (typeof window !== 'undefined' && window.THERMAL_GUARD_AI && typeof window.THERMAL_GUARD_AI === 'object') {
    setExternalAiConfig(window.THERMAL_GUARD_AI)
  } else if (typeof fetch === 'function') {
    try {
      const response = await fetch('./ai-config.json', { cache: 'no-store' })
      if (response.ok) {
        const config = await response.json()
        if (config && typeof config === 'object') setExternalAiConfig(config)
      }
    } catch {}
  }
  // 云端通道也可以在配置文件里预置（例如部署好 Cloudflare Worker 后写进 ai-config.json），
  // 用户本机手动填过的通道优先级更高，不会被覆盖。
  const presetChannel = (typeof window !== 'undefined' && window.THERMAL_GUARD_CLOUD)
    || getExternalAiConfig()?.cloudChannel
    || ''
  if (presetChannel && !readCloudChannel()) {
    saveCloudChannel(String(presetChannel).trim())
  }
  // 区域频道表也可以由配置文件预置（例如"每个小区/楼栋一个频道"）
  const presetAreas = getExternalAiConfig()?.areaChannels
  if (Array.isArray(presetAreas) && presetAreas.length) {
    const { readAreaChannels, saveAreaChannels } = await import('./geoChannels.js')
    const current = readAreaChannels()
    const isDefault = current.length === 1 && current[0]?.id === 'must-campus'
    if (isDefault) saveAreaChannels(presetAreas)
  }
  installGlobalAiApi()
  return readAiSettings()
}

// 队友的接入面板：控制台里执行 window.ThermalGuardAI.help() 会打印用法
export function installGlobalAiApi() {
  if (typeof window === 'undefined') return null
  const api = {
    version: 1,
    phases: ['prevention', 'response', 'aftermath'],
    providers: listAiProviders,
    registerProvider,
    registerVisionDetector,
    registerVitalSensor,
    getVisionDetector,
    getVitalSensor,
    runVisionDetector,
    readVitalFrame,
    integrationStatus,
    subscribeIntegrations,
    readSettings: readAiSettings,
    saveSettings: saveAiSettings,
    setExternalConfig: setExternalAiConfig,
    command: aiCommand,
    help() {
      console.log([
        '热感哨兵 · AI 接入接口（v1）',
        '1) 加推理端点：ThermalGuardAI.registerProvider({ id, label, baseUrl, model, hint })',
        '2) 接视觉通道：ThermalGuardAI.registerVisionDetector(async ({ frame, image }) => ({ flame: 0.9, smoke: 0.4 }))',
        '3) 接红外设备：ThermalGuardAI.registerVitalSensor(async () => ({ width: 32, height: 24, temperatures: [...768 个数] }))',
        '4) 看当前状态：ThermalGuardAI.integrationStatus()',
        '5) 写入端点配置：ThermalGuardAI.saveSettings({ provider: "ollama", baseUrl: "/ai/v1", model: "qwen2.5:7b" })',
      ].join('\n'))
      return integrationStatus()
    },
  }
  window.ThermalGuardAI = api
  return api
}

// 端点可用性探测：不抛异常，只返回布尔值（默认 1.2 秒，避免拖慢现场操作）
export async function aiReachable(settings = readAiSettings(), timeoutMs = 1200) {
  const { baseUrl } = settings
  if (!baseUrl || settings.provider === 'offline') return false
  if (typeof fetch === 'undefined') return false
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : undefined,
      signal: controller?.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function aiChat(messages, settings = readAiSettings(), timeoutMs = settings.timeoutMs ?? 6000) {
  if (!settings.baseUrl || settings.provider === 'offline') {
    throw new Error('ai-disabled')
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model || 'local-model',
        messages,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller?.signal,
    })
    if (!response.ok) throw new Error(`ai-http-${response.status}`)
    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('ai-empty')
    return String(text)
  } finally {
    clearTimeout(timer)
  }
}

// 带图片的一次调用：把（缩小后的）图片以 data URL 交给本地视觉模型。
// 注意：data URL 只是内存里的字符串，仍然只发往 settings.baseUrl 指向的本地端点，
// 不经过任何云端服务；端点没配或模型不支持读图时由调用方回落到纯文字或启发式结果。
export async function aiChatVision(prompt, imageDataUrl, settings = readAiSettings(), timeoutMs = settings.timeoutMs ?? 12000) {
  if (!settings.baseUrl || settings.provider === 'offline') {
    throw new Error('ai-disabled')
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model || 'local-model',
        temperature: 0.1,
        stream: false,
        messages: [
          {
            role: 'user',
            content: imageDataUrl
              ? [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ]
              : [{ type: 'text', text: prompt }],
          },
        ],
      }),
      signal: controller?.signal,
    })
    if (!response.ok) throw new Error(`ai-http-${response.status}`)
    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('ai-empty')
    return String(text)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 规则引擎（无网络兜底）
//
// 输入现场结构化数据，输出与模型同构的结果，保证下游 UI 不需要区分来源。
export function localDecision(context = {}) {
  const {
    fire = null,
    route = null,
    hazard = null,
    crowd = null,
    position = null,
    gps = null,
    plan = null,
    phase = 'response',
    prevention = null,
    vital = null,
  } = context

  // 阶段一：预防判定——该不该报警 + 给周边居民的通知
  if (phase === 'prevention') {
    const decision = prevention?.decision ?? fusePreventionSignals(prevention?.signals ?? {})
    const notice = prevention?.notice ?? buildNeighborNotice(decision, { floor: position?.floor, location: prevention?.location })
    if (decision.level === 'alarm') {
      return {
        source: 'offline-rules',
        phase,
        urgency: 'immediate',
        level: 'alarm',
        summary: `判定火警：${decision.reasons.slice(0, 2).join('；')}`,
        action: '立即触发全屏报警与应急广播，通知周边居民按指引撤离',
        instruction: notice,
      }
    }
    if (decision.level === 'watch') {
      return {
        source: 'offline-rules',
        phase,
        urgency: 'prepare',
        level: 'watch',
        summary: `关注：${decision.reasons.slice(0, 2).join('；')}`,
        action: '保持监测并派人现场核查，暂不触发全楼报警',
        instruction: notice,
      }
    }
    return {
      source: 'offline-rules',
      phase,
      urgency: 'info',
      level: 'normal',
      summary: '三路证据（热像 / 视觉 / 烟雾）均未达到报警条件',
      action: '维持值守，记录本次数据',
      instruction: notice,
    }
  }

  // 阶段三：灾后生命体征搜索——只给搜救建议，不做火警判断
  if (phase === 'aftermath') {
    const described = describeVitalSigns(vital?.result, { floor: position?.floor })
    return {
      source: 'offline-rules',
      phase,
      urgency: vital?.result?.candidates?.length ? 'immediate' : 'info',
      level: vital?.result?.candidates?.length ? 'candidates' : 'clear',
      summary: described.summary,
      action: described.action,
      instruction: described.priority.length ? described.priority.join(' / ') : '按房间逐间复扫',
    }
  }

  if (!fire) {
    return {
      source: 'offline-rules',
      urgency: 'info',
      summary: '未检测到火警，系统处于值守状态',
      action: '保持通道畅通，确认最近出口位置',
      instruction: '可在「我的位置」中开启 GPS，或上传本层逃生路线图备用',
    }
  }

  const floors = (fire.nodes ?? [fire.nodeId]).map((id) => Number(String(id).replace(/\D/g, '')) || position?.floor || 1)
  const sources = Math.max(1, fire.nodes?.length ?? 1)
  const fireFloor = Math.min(...floors)
  const blocked = route?.blockedNodes?.length ?? 0
  const stairs = crowd?.stairs ? Object.values(crowd.stairs) : []
  const congested = stairs.filter((stair) => stair.congested).map((stair) => stair.id)
  const queue = stairs.reduce((sum, stair) => sum + (stair.queue ?? 0), 0)

  const summary = [
    `${fireFloor} 楼起火`,
    sources > 1 ? `${sources} 处火源` : null,
    congested.length ? `${congested.join('/')} 梯拥堵` : null,
    queue > 12 ? `排队 ${queue} 人` : null,
  ].filter(Boolean).join(' · ')

  let action
  let instruction

  if (!route?.ok) {
    action = blocked ? '当前通道受阻，改走备用楼梯或就近房间避难并等待指引' : '正在重新计算路线，先在原地等待 5 秒'
    instruction = '不要搭乘电梯，关闭身后的防火门'
  } else if (plan?.route?.instructions?.length) {
    const step = plan.route.instructions[0]
    action = `按${plan.name || '本层路线图'}撤离，前往${plan.route.exitLabel || '最近出口'}`
    instruction = step.text
  } else {
    const exit = route.exitLabel || '最近安全出口'
    action = `撤离至${exit}，约 ${Math.round(route.meters ?? 0)} 米`
    instruction = congested.length
      ? `避开拥堵的 ${congested.join('/')} 梯，改走另一条楼梯`
      : '保持当前方向前进，注意地面指示'
  }

  if (gps?.status === 'active' && gps.location && !gps.location.inside) {
    instruction += `；你已在校园外，可前往集合点方向`
  }

  return {
    source: 'offline-rules',
    phase: 'response',
    urgency: route?.ok ? 'immediate' : 'prepare',
    summary,
    action,
    instruction,
  }
}

export function buildCommanderMessages(context) {
  // 按阶段选提示词：预防阶段看证据、起火阶段看路线、灾后阶段看生命体征候选
  return buildPhaseMessages(context?.phase ?? 'response', context)
}

function parseModelReply(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const parsed = safeParse(text.slice(start, end + 1))
  if (!parsed?.action) return null
  return {
    source: 'local-model',
    urgency: parsed.urgency ?? 'immediate',
    level: parsed.level ?? null,
    summary: String(parsed.summary ?? '').slice(0, 120),
    action: String(parsed.action).slice(0, 120),
    instruction: String(parsed.instruction ?? parsed.notice ?? '').slice(0, 160),
    rescue: parsed.rescue ? String(parsed.rescue).slice(0, 160) : null,
    priority: parsed.priority ? String(parsed.priority).slice(0, 160) : null,
    caution: parsed.caution ? String(parsed.caution).slice(0, 160) : null,
  }
}

// 统一入口：优先本地模型，失败或未配置时用规则引擎
export async function aiCommand(context, settings = readAiSettings()) {
  const fallback = localDecision(context)
  const phase = context?.phase ?? 'response'
  if (settings.provider === 'offline' || !settings.baseUrl) {
    return { ...fallback, phase, attempted: false }
  }
  try {
    const text = await aiChat(buildCommanderMessages(context), settings)
    const parsed = parseModelReply(text)
    return parsed ? { ...parsed, phase, attempted: true } : { ...fallback, phase, attempted: true, modelReplyInvalid: true }
  } catch (error) {
    return { ...fallback, phase, attempted: true, error: String(error?.message ?? error) }
  }
}
