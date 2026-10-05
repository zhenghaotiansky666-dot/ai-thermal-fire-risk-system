// 用户端上报（隐患随手拍 / 被困求助）→ 系统端联动的纯逻辑单测

import {
  HAZARD_KEY,
  addHazard,
  hazardFromEvent,
  helpFromEvent,
  imageForEvent,
  mergeHazards,
  normalizeHazard,
  publishHazard,
  publishHelp,
  readHazards,
  removeHazard,
  uploadPhotoToChannel,
  writeHazards,
} from '../src/shared/userReports.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 一个最小的 localStorage 替身（Node 里没有 window）
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() { return map.size },
  }
}

console.log('[1] 记录归一化')
{
  const record = normalizeHazard({ text: '楼道堆物', location: '三楼', time: '2026/10/5 10:00' })
  check('缺 id 自动补一个', typeof record.id === 'string' && record.id.startsWith('hz-'))
  check('text/location 映射到 desc/loc', record.desc === '楼道堆物' && record.loc === '三楼')
  check('没有图时 img 是空串', record.img === '')
  check('空记录也能兜底成可读文案', normalizeHazard({}).desc === '未描述' && normalizeHazard({}).loc === '未填写位置')
}

console.log('[2] 事件过滤：只认带 category 的上报')
{
  const hazardEvent = { kind: 'report', at: 1000, from: 'user', payload: { category: 'hazard', id: 'h1', desc: '线路发热', loc: '三楼配电箱' } }
  const helpEvent = { kind: 'report', at: 1000, from: 'user', payload: { category: 'help', id: 'u1', floor: 4, needsHelp: true, advice: '请到窗边等待' } }
  check('隐患事件能解析', hazardFromEvent(hazardEvent)?.desc === '线路发热')
  check('求助事件不会被当成隐患', hazardFromEvent(helpEvent) === null)
  check('求助事件能解析', helpFromEvent(helpEvent)?.needsHelp === true)
  check('隐患事件不会被当成求助', helpFromEvent(hazardEvent) === null)
  check('火警事件不参与', hazardFromEvent({ kind: 'fire', payload: {} }) === null && helpFromEvent({ kind: 'status', payload: {} }) === null)
}

console.log('[3] 合并去重与排序')
{
  const merged = mergeHazards(
    [{ id: 'a', desc: '旧', at: 1 }, { id: 'b', desc: '乙', at: 5 }],
    [{ id: 'a', desc: '新', at: 9 }, { id: 'c', desc: '丙', at: 7 }],
  )
  check('同 id 保留较新的一条', merged.find((item) => item.id === 'a')?.desc === '新')
  check('按时间倒序', merged.map((item) => item.id).join(',') === 'a,c,b')
  check('条数上限生效', mergeHazards([], Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, at: i }))).length === 20)
}

console.log('[4] 本机存储读写')
{
  const storage = fakeStorage()
  check('空存储返回空数组', readHazards(storage).length === 0)
  writeHazards([{ id: 'a', desc: '堆物', at: 2 }], storage)
  check('写进去能读出来', readHazards(storage)[0]?.desc === '堆物')
  check('用的是系统端同一把键', storage.getItem(HAZARD_KEY) !== null)
  addHazard({ id: 'b', desc: '发热', at: 3 }, storage)
  check('新的一条排在最前', readHazards(storage)[0]?.id === 'b')
  removeHazard('b', storage)
  check('删除只影响指定的一条', readHazards(storage).length === 1 && readHazards(storage)[0].id === 'a')
}

console.log('[5] 照片体积控制：塞不进消息体的图不能硬塞')
{
  const small = `data:image/jpeg;base64,${'A'.repeat(100)}`
  const huge = `data:image/jpeg;base64,${'A'.repeat(200_000)}`
  check('小图原样带上', imageForEvent(small) === small)
  check('大图不塞进事件（避免把中继打爆）', imageForEvent(huge) === '')
  check('已经是远程链接就照传', imageForEvent('https://ntfy.sh/file/abc.jpg') === 'https://ntfy.sh/file/abc.jpg')
}

console.log('[6] ntfy 附件：照片先传附件，事件里只留链接')
{
  const calls = []
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' })
    if (!options.method) return { ok: true, blob: async () => ({ type: 'image/jpeg' }) }
    return { ok: true, json: async () => ({ attachment: { url: 'https://ntfy.sh/file/hazard.jpg' } }) }
  }
  const url = await uploadPhotoToChannel('ntfy:tg-demo-topic', 'data:image/jpeg;base64,AAAA', { fetchImpl: fakeFetch })
  check('返回附件 URL', url === 'https://ntfy.sh/file/hazard.jpg')
  check('用 PUT 传附件', calls.some((call) => call.method === 'PUT'))
  check('非 ntfy 通道不传附件', (await uploadPhotoToChannel('https://relay.example.com', 'data:image/jpeg;base64,AAAA', { fetchImpl: fakeFetch })) === '')
}

console.log('[7] 发布：事件结构能被系统端直接消费')
{
  const published = []
  const bus = { publish: async (event) => { published.push(event); return event } }
  const record = { id: 'hz-1', desc: '线路发热', loc: '三楼', at: 1000, floor: 3, spot: 'C', img: `data:image/jpeg;base64,${'A'.repeat(100)}` }
  const event = await publishHazard(bus, record, { channel: '' })
  check('发布的是 report 事件', event.kind === 'report' && published.length === 1)
  check('带上 category=hazard', event.payload.category === 'hazard')
  check('位置与描述都带上了', event.payload.desc === '线路发热' && event.payload.loc === '三楼' && event.payload.floor === 3)
  check('小图直接内联', event.payload.img.startsWith('data:image'))
  check('来自用户端', event.from === 'user')
  check('系统端能反向解析回记录', hazardFromEvent(event)?.desc === '线路发热')

  const helpEvent = await publishHelp(bus, { id: 'u1', floor: 5, spot: 'B', needsHelp: true, advice: '请原地等待救援', updatedAt: 2000 })
  check('求助同样走 report 通道', helpEvent.kind === 'report' && helpEvent.payload.category === 'help')
  check('求助解析回状态', helpFromEvent(helpEvent)?.needsHelp === true)
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exitCode = 1
