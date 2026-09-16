// 系统端「AI 指挥」设置：把本地大模型的接口放在指挥端配置一次。
//
// 为什么放在系统端：现场部署时，是值守/指挥这台机器上跑 Ollama / LM Studio / vLLM，
// 消防管理员来这里填一次地址，用户端（同一台手机或浏览器）会共用同一份设置，
// 于是断网时两边都走这台本地模型，模型不可用时自动回落本机规则引擎。
//
// 设置存在 localStorage（键在 src/shared/aiClient.js 里统一定义），密钥不出本机。

import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, Save, Server, Stethoscope, TriangleAlert, X } from 'lucide-react'
import { aiReachable, listAiProviders, providerPreset, readAiSettings, saveAiSettings } from '../shared/aiClient.js'
import { integrationStatus, subscribeIntegrations } from '../shared/aiHooks.js'

export default function AiCommandSheet({ onClose, onSaved }) {
  const [form, setForm] = useState(() => readAiSettings())
  const [probe, setProbe] = useState('')
  const [saved, setSaved] = useState('')
  const [status, setStatus] = useState(() => integrationStatus())
  const [diagnose, setDiagnose] = useState(null)
  const [diagnosing, setDiagnosing] = useState(false)

  // 队友在控制台里注册能力后，这个面板会立刻反映"已接入"
  useEffect(() => subscribeIntegrations(() => setStatus(integrationStatus())), [])

  const patch = (next) => setForm((current) => ({ ...current, ...next }))
  const offline = form.provider === 'offline'

  const test = async () => {
    setProbe('testing')
    const ok = await aiReachable(form)
    setProbe(ok ? 'ok' : 'fail')
  }

  const persist = () => {
    const next = saveAiSettings(form)
    setSaved('已保存到本机，用户端会自动使用同一份设置')
    onSaved?.(next)
    window.setTimeout(() => setSaved(''), 3200)
  }

  // 一键诊断：让本地服务器替页面去探模型端口（浏览器自己探不了 127.0.0.1 之外的内网地址）
  const runDiagnose = async () => {
    setDiagnosing(true)
    setDiagnose(null)
    try {
      const response = await fetch(`./ai/diagnose?model=${encodeURIComponent(form.model || '')}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`http-${response.status}`)
      setDiagnose(await response.json())
    } catch (error) {
      setDiagnose({
        ok: false,
        summary: { headline: '当前页面不是通过本地服务器打开的，无法在页面里诊断' },
        checks: [{
          id: 'not-local',
          level: 'fail',
          title: '诊断需要本地服务器（tools/local-ai-server.mjs）',
          detail: String(error?.message ?? error),
          remedy: '在跑模型的电脑上执行 node tools/setup-local-ai.mjs，然后用它打印的地址打开本页',
        }],
      })
    } finally {
      setDiagnosing(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="device-sheet ai-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div><span>应急指挥</span><strong>AI 指挥 · 本地模型接口</strong></div>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="sheet-tip">
          <Server size={14} />
          把本地大模型部署在现场机器或边缘盒子（Ollama / LM Studio / vLLM 等 OpenAI 兼容端点），
          在这里填一次地址与模型名即可接管指挥决策；<b>断网或端点不可用时自动回落本机规则引擎</b>，不会没有指令。
        </div>

        <label className="ai-sheet-field">
          推理来源
          <select
            value={form.provider}
            onChange={(event) => {
              const preset = AI_PROVIDERS[event.target.value]
              patch({ provider: preset.id, baseUrl: preset.baseUrl, model: preset.model })
            }}
          >
            {Object.values(listAiProviders()).map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </label>
        <p className="ai-sheet-hint">{providerPreset(form.provider)?.hint}</p>
        <p className="ai-sheet-hint">
          现场部署：在本机跑 <b>node tools/local-ai-server.mjs</b>，改用 http://127.0.0.1:4173 打开系统端，
          端点填相对路径 <b>/ai/v1</b>。这样站点与模型同在 http 源内，断网也能指挥；公网 HTTPS 页面会拦截 http 端点。
        </p>

        <label className="ai-sheet-field">
          端点地址
          <input
            type="url"
            inputMode="url"
            placeholder="http://127.0.0.1:11434/v1"
            value={form.baseUrl}
            disabled={offline}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </label>
        <label className="ai-sheet-field">
          模型名
          <input
            type="text"
            placeholder="qwen2.5:7b"
            value={form.model}
            disabled={offline}
            onChange={(event) => patch({ model: event.target.value })}
          />
        </label>
        <label className="ai-sheet-field">
          访问密钥（可选）
          <input
            type="password"
            placeholder="本地端点一般不需要"
            value={form.apiKey}
            disabled={offline}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
        </label>
        <label className="ai-sheet-check">
          <input
            type="checkbox"
            checked={Boolean(form.vision)}
            disabled={offline}
            onChange={(event) => patch({ vision: event.target.checked })}
          />
          该模型支持读图（视觉模型，用于复核用户上传的疏散路线图）
        </label>

        <div className="ai-sheet-actions">
          <button type="button" className="sheet-save" onClick={persist}><Save size={16} />保存设置</button>
          <button type="button" onClick={test} disabled={offline || probe === 'testing'}>
            <RefreshCw size={15} /> {probe === 'testing' ? '正在测试…' : '测试连接'}
          </button>
          <button type="button" onClick={runDiagnose} disabled={diagnosing}>
            <Stethoscope size={15} /> {diagnosing ? '诊断中…' : '一键诊断'}
          </button>
          {diagnose?.ok && diagnose?.hints?.matchedModel && (
            <button
              type="button"
              className="ai-apply"
              onClick={() => {
                // 一键采用诊断给出的推荐值：同源代理 + 本机真实存在的模型名
                patch({ provider: 'custom', baseUrl: diagnose.hints.endpointForBrowser || '/ai/v1', model: diagnose.hints.matchedModel })
                setSaved('已填入推荐设置，点「保存设置」生效')
                window.setTimeout(() => setSaved(''), 3200)
              }}
            >
              <Cpu size={15} /> 应用推荐设置
            </button>
          )}
          <span className={`ai-probe ${probe === 'ok' ? 'is-ok' : probe === 'fail' ? 'is-fail' : ''}`}>
            {probe === 'ok' ? '端点可用，将由本地模型接管' : probe === 'fail' ? '端点不可用（仍可使用规则引擎）' : '未测试'}
          </span>
        </div>

        {diagnose && (
          <div className={`ai-diagnose ${diagnose.ok ? 'is-ok' : 'is-bad'}`}>
            <strong>{diagnose.summary?.headline ?? '诊断完成'}</strong>
            <ul>
              {(diagnose.checks ?? []).map((check) => (
                <li key={check.id} className={`level-${check.level}`}>
                  <span>{check.level === 'pass' ? '✅' : check.level === 'warn' ? '⚠️' : '❌'} {check.title}</span>
                  {check.remedy && <em>怎么修：{check.remedy}</em>}
                </li>
              ))}
            </ul>
            {diagnose.hints?.lanSite && <p>队友/手机请打开：{diagnose.hints.lanSite}，端点填 {diagnose.hints.endpointForBrowser}</p>}
          </div>
        )}

        {saved && <div className="ai-sheet-saved">{saved}</div>}

        <div className="ai-sheet-status">
          <strong>接入状态（队友在这里对接，界面会自动生效）</strong>
          <ul>
            <li>推理端点：{form.baseUrl ? `已填 ${form.baseUrl}` : '未填（用本机规则引擎）'}</li>
            <li>视觉通道（阶段一火焰/烟雾）：{status.vision ? '已接入' : '未接入（界面用演示滑杆）'}</li>
            <li>红外设备（阶段三热像源）：{status.vital ? '已接入' : '未接入（用模拟灾后帧）'}</li>
            <li>额外端点预设：{status.providers.length ? status.providers.join('、') : '无'}</li>
          </ul>
          <span>在控制台执行 <code>ThermalGuardAI.help()</code> 可以看到接入写法；也可以直接改站点根目录的 <code>ai-config.json</code>。</span>
        </div>

        <div className="sheet-tip protocol-tip">
          <Cpu size={14} />
          推荐：8B 级量化模型 + 视觉模型各一（例如 qwen2.5:7b 负责决策、qwen2.5-vl 负责读路线图），现场机器 16GB 内存可跑。
        </div>
        {offline && (
          <div className="sheet-tip">
            <TriangleAlert size={14} />
            当前是本机规则引擎：不调用任何模型，按危险场、路线与现场数据直接给出指令，断网也可用。
          </div>
        )}
      </section>
    </div>
  )
}
