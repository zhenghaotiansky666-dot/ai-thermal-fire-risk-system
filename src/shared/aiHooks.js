// AI 能力接入点（给队友用的接口层）
//
// 我们的原则：**界面里的 AI 功能全部走这里注册的接口**，队友不需要改我们的 UI 代码，
// 只要在页面加载后（或自己的脚本里）注册三项中的任意一项即可接管：
//
//   1. registerProvider(preset)         —— 加一个推理端点预设（本地 Ollama、云端豆包/DeepSeek、
//                                          自建网关都可以，只要兼容 OpenAI 的 /chat/completions）
//   2. registerVisionDetector(fn)       —— 接管阶段一的"视觉火焰 + 烟雾"通道
//                                          签名：async ({ frame, image }) => ({ flame, smoke, note })
//   3. registerVitalSensor(fn)          —— 接管阶段三的热像源（真实红外设备）
//                                          签名：async () => ({ width, height, temperatures, ambient })
//
// 注册后界面上会立刻显示"已接入"，并优先使用真实通道；没注册就用演示输入 / 模拟帧。
// 所有注册都是幂等的，重复注册会覆盖上一个实现（便于热插拔调试）。

const registry = {
  providers: {},
  visionDetector: null,
  vitalSensor: null,
}

// 内置的 YOLO 视觉通道桥：只要设置了 visionUrl，就自动把检测服务接进视觉通道，
// 不需要队友改任何代码（阶段一的三路证据融合会直接用它的火焰/烟雾置信度）
let visionBridge = null

export function installVisionBridge(detector) {
  if (!isFunction(detector)) return false
  visionBridge = detector
  // 不覆盖团队手动注册的视觉通道
  if (!registry.visionDetector) registry.visionDetector = detector
  notify('vision-bridge')
  return true
}

export function getVisionBridge() {
  return visionBridge
}

const listeners = new Set()

function notify(reason) {
  listeners.forEach((listener) => {
    try {
      listener({ reason, status: integrationStatus() })
    } catch {}
  })
}

function isFunction(value) {
  return typeof value === 'function'
}

// ---------------------------------------------------------------- 1. 推理端点预设
export function registerProvider(preset) {
  if (!preset || typeof preset !== 'object' || !preset.id) return null
  registry.providers[preset.id] = {
    id: String(preset.id),
    label: String(preset.label ?? preset.id),
    hint: String(preset.hint ?? ''),
    baseUrl: String(preset.baseUrl ?? ''),
    model: String(preset.model ?? ''),
    ...(preset.vision === undefined ? {} : { vision: Boolean(preset.vision) }),
  }
  notify(`provider:${preset.id}`)
  return registry.providers[preset.id]
}

export function listExtraProviders() {
  return { ...registry.providers }
}

// ---------------------------------------------------------------- 2. 阶段一：视觉通道
export function registerVisionDetector(detector) {
  registry.visionDetector = isFunction(detector) ? detector : null
  notify('vision')
  return Boolean(registry.visionDetector)
}

export function getVisionDetector() {
  return registry.visionDetector
}

// 统一调用方式：任何失败都当成"没接入"，绝不打断报警与疏散流程
export async function runVisionDetector(input = {}) {
  if (!registry.visionDetector) return { attached: false, flame: null, smoke: null, note: '视觉通道未接入' }
  try {
    const result = await registry.visionDetector(input)
    if (!result || typeof result !== 'object') return { attached: true, flame: null, smoke: null, note: '视觉通道返回空结果' }
    return {
      attached: true,
      flame: result.flame === undefined || result.flame === null ? null : Math.max(0, Math.min(1, Number(result.flame))),
      smoke: result.smoke === undefined || result.smoke === null ? null : Math.max(0, Math.min(1, Number(result.smoke))),
      note: result.note ? String(result.note).slice(0, 120) : '',
    }
  } catch (error) {
    return { attached: true, flame: null, smoke: null, note: `视觉通道报错：${String(error?.message ?? error).slice(0, 80)}` }
  }
}

// ---------------------------------------------------------------- 3. 阶段三：热像源
export function registerVitalSensor(reader) {
  registry.vitalSensor = isFunction(reader) ? reader : null
  notify('vital')
  return Boolean(registry.vitalSensor)
}

export function getVitalSensor() {
  return registry.vitalSensor
}

// 读取一帧热像；返回结构必须是 { width, height, temperatures: number[] }，否则视为失败
export async function readVitalFrame(fallbackFrame) {
  if (!registry.vitalSensor) return { attached: false, frame: fallbackFrame, note: '红外设备未接入，使用模拟灾后帧' }
  try {
    const frame = await registry.vitalSensor()
    const valid = frame
      && Number.isFinite(Number(frame.width))
      && Number.isFinite(Number(frame.height))
      && Array.isArray(frame.temperatures)
      && frame.temperatures.length === Number(frame.width) * Number(frame.height)
    if (!valid) return { attached: true, frame: fallbackFrame, note: '红外设备返回的矩阵尺寸不匹配，已回退模拟帧' }
    return { attached: true, frame, note: '' }
  } catch (error) {
    return { attached: true, frame: fallbackFrame, note: `红外设备读取失败：${String(error?.message ?? error).slice(0, 80)}` }
  }
}

// ---------------------------------------------------------------- 状态与订阅
export function integrationStatus() {
  return {
    providers: Object.keys(registry.providers),
    vision: Boolean(registry.visionDetector),
    vital: Boolean(registry.vitalSensor),
  }
}

export function subscribeIntegrations(listener) {
  if (!isFunction(listener)) return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// 测试与热重载用：清空所有注册
export function resetIntegrations() {
  registry.providers = {}
  registry.visionDetector = null
  registry.vitalSensor = null
  notify('reset')
}
