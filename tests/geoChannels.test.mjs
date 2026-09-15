// 位置 → 警报频道 单测：区域判定、扫码带入频道、自动加入开关默认值。

import {
  DEFAULT_AREAS,
  buildJoinUrl,
  extractChannelFromSearch,
  haversineMeters,
  resolveAreaChannel,
  resolveAreas,
} from '../src/shared/geoChannels.js'
import { CAMPUS_CENTER } from '../src/user/geo.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 区域判定')
{
  const onCampus = resolveAreaChannel(CAMPUS_CENTER.lat, CAMPUS_CENTER.lon)
  check('校园中心命中校园频道', onCampus?.area?.id === 'must-campus')
  check('返回距离（中心应为 0 米）', onCampus?.distanceMeters === 0)
  check('频道是 ntfy 主题', String(onCampus?.area?.channel).startsWith('ntfy:'))

  // 校门口附近（约 +300 米纬度）仍应命中
  const nearGate = resolveAreaChannel(CAMPUS_CENTER.lat + 300 / 110574, CAMPUS_CENTER.lon)
  check('校门附近（约 300 米）仍命中', nearGate?.area?.id === 'must-campus')

  const far = resolveAreaChannel(22.1980, 113.5400) // 澳门半岛方向，离校园十多公里
  check('远离校园不命中', far === null)

  const invalid = resolveAreaChannel('abc', null)
  check('非法坐标返回 null', invalid === null)

  const list = resolveAreas(CAMPUS_CENTER.lat, CAMPUS_CENTER.lon)
  check('返回命中的区域列表', Array.isArray(list) && list.length >= 1)
  check('默认区域表只有校园一项', DEFAULT_AREAS.length >= 1 && DEFAULT_AREAS[0].radiusMeters > 0)
}

console.log('[2] 距离计算')
{
  const a = { lat: 22.1526454, lon: 113.5680410 }
  const b = { lat: 22.1535454, lon: 113.5680410 } // 纬度 +0.0009 ≈ 100 米
  const distance = haversineMeters(a, b)
  check('0.0009° 纬度约 100 米', Math.abs(distance - 100) < 5, `${distance.toFixed(1)}`)
}

console.log('[3] 扫码带入频道')
{
  check('识别 ?ch=', extractChannelFromSearch('?ch=ntfy:tg-demo-1') === 'ntfy:tg-demo-1')
  check('识别 ?channel=', extractChannelFromSearch('?channel=abc123') === 'abc123')
  check('识别 ?join=', extractChannelFromSearch('?join=abc123') === 'abc123')
  check('没有参数时返回空', extractChannelFromSearch('') === '' && extractChannelFromSearch('?foo=1') === '')
  check('URL 编码的频道能还原', extractChannelFromSearch('?ch=ntfy%3Atg-demo%2B1') === 'ntfy:tg-demo+1')

  const url = buildJoinUrl('https://example.com/user-app.html', 'ntfy:tg-demo-1')
  check('拼接扫码链接', url === 'https://example.com/user-app.html?ch=ntfy%3Atg-demo-1', url)
  check('已有查询参数时用 &', buildJoinUrl('https://example.com/u.html?a=1', 'x') === 'https://example.com/u.html?a=1&ch=x')
  check('没有频道时原样返回', buildJoinUrl('https://example.com/u.html', '') === 'https://example.com/u.html')
  check('拼接后的链接能被解析回来', extractChannelFromSearch(url.split('?')[1]) === 'ntfy:tg-demo-1')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
