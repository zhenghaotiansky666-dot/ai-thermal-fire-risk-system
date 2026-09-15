// 更新机制单测：版本比对逻辑（纯函数部分）

import { describeBuild, isStale } from '../src/shared/updateCheck.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 版本比对')
{
  check('线上与本机一致 → 不是旧版', isStale('1.0.3-abc1234', '1.0.3-abc1234') === false)
  check('线上不同 → 提示更新', isStale('1.0.3-abc1234', '1.0.3-def5678') === true)
  check('拿不到线上版本 → 不打扰用户', isStale('1.0.3-abc1234', '') === false)
  check('本地没有内置版本（开发模式）→ 不提示', isStale('', '1.0.3-abc1234') === false)
  check('两边都是空 → 不提示', isStale('', '') === false)
}

console.log('[2] 版本展示')
{
  check('有版本号时原样显示', describeBuild('1.0.3-abc1234') === '1.0.3-abc1234')
  check('没有版本号时显示开发模式', describeBuild('') === '开发模式')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
