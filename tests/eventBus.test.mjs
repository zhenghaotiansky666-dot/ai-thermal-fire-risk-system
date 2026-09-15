// 两端链路纯逻辑单测：事件结构、离线码编解码、去重与过期、链路选择、火情结构转换。

import {
  DEFAULT_TTL_MS,
  chooseTransport,
  createEvent,
  decodeEventCode,
  describeTransport,
  encodeEventCode,
  fireFromEvent,
  isExpired,
  mergeEvents,
  makeCloudChannel,
  parseCloudChannel,
  peerReportSummary,
  withQuery,
} from '../src/shared/eventBus.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 事件结构')
{
  const event = createEvent('fire', { nodeId: 'C4', floor: 4 }, { at: 1000, from: 'system' })
  check('带版本号与 id', event.v === 1 && typeof event.id === 'string' && event.id.startsWith('fire-'))
  check('记录来源与时间', event.from === 'system' && event.at === 1000)
  check('默认 TTL 为 30 分钟', event.ttl === DEFAULT_TTL_MS)
  check('未知类型直接报错', (() => { try { createEvent('unknown')
    return false } catch { return true } })())

  check('超过 TTL 视为过期', isExpired({ at: 0, ttl: 1000 }, 5000) === true)
  check('TTL 内不过期', isExpired({ at: 4500, ttl: 1000 }, 5000) === false)
  check('缺少时间视为过期', isExpired({ ttl: 1000 }) === true)
}

console.log('[2] 离线码编解码')
{
  const event = createEvent('fire', { nodeId: 'C4', floor: 4, startedAt: 111, mode: 'drill', notice: '4 楼东侧起火，请按指引撤离' }, { at: 2000, id: 'fire-test' })
  const code = encodeEventCode(event)
  check('码带前缀', code.startsWith('TGS1-'))
  check('码里没有换行与加号斜杠', !/[\s+/=]/.test(code))
  const back = decodeEventCode(code)
  check('往返一致（类型/id/时间）', back.kind === 'fire' && back.id === 'fire-test' && back.at === 2000)
  check('往返一致（火源与通知文案）', back.payload.nodeId === 'C4' && back.payload.notice.includes('按指引撤离'))
  check('中间的换行/空格会被忽略', decodeEventCode(code.replace(/(.{20})/, '$1\n  '))?.id === 'fire-test')
  check('乱码返回 null', decodeEventCode('TGS1-这不是base64') === null)
  check('空值返回 null', decodeEventCode('') === null && decodeEventCode(null) === null)
  check('少了前缀也能解（人工复制场景）', decodeEventCode(code.slice(5))?.id === 'fire-test')
}

console.log('[3] 去重 / 过期 / 容量')
{
  const now = 10_000
  const list = [
    createEvent('notice', { text: 'a' }, { id: 'e1', at: now - 9000 }),
    createEvent('notice', { text: 'b' }, { id: 'e2', at: now - 8000 }),
  ]
  const merged = mergeEvents(list, [
    createEvent('notice', { text: 'b2' }, { id: 'e2', at: now - 1000 }),
    createEvent('notice', { text: 'c' }, { id: 'e3', at: now - 500 }),
    createEvent('notice', { text: 'old' }, { id: 'e4', at: now - 60 * 60 * 1000, ttl: 1000 }),
  ], { now })
  check('同 id 用更新的那条', merged.find((item) => item.id === 'e2').payload.text === 'b2')
  check('过期事件被丢弃', !merged.some((item) => item.id === 'e4'))
  check('按时间正序', merged[0].at <= merged[merged.length - 1].at)
  check('容量上限生效', mergeEvents([], Array.from({ length: 80 }, (_, index) => createEvent('notice', { text: String(index) }, { id: `x${index}`, at: now - index })), { now, limit: 10 }).length === 10)
}

console.log('[4] 链路选择')
{
  check('配了云端通道就优先走云端（住户手机蜂窝网络）', chooseTransport({ cloudOk: true, relayOk: true }) === 'cloud')
  check('中继可用时走局域网', chooseTransport({ relayOk: true }) === 'lan')
  check('中继不可用但有同机通道时走本地', chooseTransport({ relayOk: false, hasLocal: true }) === 'local')
  check('什么都没有时只能用离线码', chooseTransport({ relayOk: false, hasLocal: false }) === 'code')
  check('强制人工时用离线码', chooseTransport({ relayOk: true, manualOnly: true }) === 'code')
  check('文案能说清是否需要互联网', describeTransport('lan').includes('不需要互联网') && describeTransport('code').includes('不需要网络'))
  check('云端文案说明蜂窝网络可用', describeTransport('cloud').includes('蜂窝'))
}

console.log('[4b] 云端通道解析')
{
  const ntfy = parseCloudChannel('ntfy:tg-abc123')
  check('ntfy 模式识别主题', ntfy.mode === 'ntfy' && ntfy.topic === 'tg-abc123')
  check('ntfy 发布地址正确', ntfy.publishUrl === 'https://ntfy.sh/tg-abc123')
  check('ntfy 轮询地址正确', ntfy.pollUrl === 'https://ntfy.sh/tg-abc123/json')
  check('ntfy 探测走带 CORS 的 json 端点，且只用 30 秒窗口', ntfy.healthUrl.includes('/json?poll=1&since=30s'))

  const bare = parseCloudChannel('tg-abc123')
  check('不带前缀也按 ntfy 处理', bare.mode === 'ntfy' && bare.topic === 'tg-abc123')

  const rest = parseCloudChannel('https://relay.example.com/')
  check('自定义中继走 rest 模式', rest.mode === 'rest' && rest.publishUrl === 'https://relay.example.com/events')
  check('自定义中继健康检查地址', rest.healthUrl === 'https://relay.example.com/health')
  check('不分组时没有 topic 参数', !rest.publishUrl.includes('topic='))

  const scoped = parseCloudChannel('https://relay.example.com#building-a')
  check('用 #分组 区分小区/楼栋', scoped.topic === 'building-a' && scoped.publishUrl === 'https://relay.example.com/events?topic=building-a')
  check('分组也带在轮询与健康检查上', scoped.pollUrl.includes('topic=building-a') && scoped.healthUrl.includes('topic=building-a'))
  check('分组地址再拼 since 时不会出现两个问号', withQuery(scoped.pollUrl, { since: '7' }) === 'https://relay.example.com/events?topic=building-a&since=7')
  check('不带分组的地址拼参数用问号', withQuery('https://relay.example.com/events', { since: '7' }) === 'https://relay.example.com/events?since=7')
  check('空游标不拼多余参数', withQuery('https://relay.example.com/events', { since: '' }) === 'https://relay.example.com/events')

  check('空值视为关闭', parseCloudChannel('').mode === 'off')
  check('非法主题被拒绝', parseCloudChannel('ntfy:带空格 的 主题').mode === 'off')

  const generated = makeCloudChannel()
  check('生成的通道以 ntfy: 开头且可解析', generated.startsWith('ntfy:') && parseCloudChannel(generated).mode === 'ntfy')
  check('生成的通道足够随机（两次不同）', makeCloudChannel() !== makeCloudChannel())
}

console.log('[5] 火情事件 → 传感器结构')
{
  const multi = fireFromEvent(createEvent('fire', { nodeId: 'C4', floor: 4, startedAt: 123, mode: 'live', nodes: ['C4', 'C5'] }, { at: 999 }))
  check('转换出 nodeId 与楼层', multi.nodeId === 'C4' && multi.floor === 4)
  check('保留多火源列表', Array.isArray(multi.nodes) && multi.nodes.length === 2)
  check('startedAt 优先用火情里的时间', multi.startedAt === 123)
  check('缺少 nodeId 时返回 null', fireFromEvent(createEvent('fire', { floor: 4 })) === null)
  check('非火情事件返回 null', fireFromEvent(createEvent('notice', {})) === null)
}

console.log('[6] 用户端上报 → 系统端横幅摘要')
{
  const fire = peerReportSummary(createEvent('report', { floor: 4, spot: 'C', text: '我这里看到明火或浓烟' }, { at: 5000, from: 'user' }))
  check('识别为疑似火情', fire.severity === 'fire' && fire.fireSeen === true)
  check('摘要带楼层与位置', fire.place.includes('4 楼') && fire.place.includes('C'))
  check('摘要给出提示标签', fire.label.includes('疑似火情'))

  const help = peerReportSummary(createEvent('report', { floor: 6, spot: 'A', text: '我走不动了，需要帮助' }, { at: 6000, from: 'user' }))
  check('普通求助不误判成火情', help.severity === 'help' && help.fireSeen === false)
  check('缺楼层时不崩', peerReportSummary(createEvent('report', { text: '有烟' })).place.includes('楼层未知'))
  check('非 report 事件返回 null', peerReportSummary(createEvent('fire', { nodeId: 'C4' })) === null)
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
