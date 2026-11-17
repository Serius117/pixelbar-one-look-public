/**
 * tools/sim.ts —— L3 开发机交互验证（测试设计 §5）：TC 用例倍速回放 + 终端虚拟 PixelBar。
 * 用法：npm run demo -- --case TC-B2 [--speed 6] | --suite B [--speed 6] | --list
 */
import { ScaledClock } from '../src/clock.ts'
import { CASES } from '../src/test-cases.ts'
import { runTimelineCase } from '../src/test-runner.ts'

const args = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const speed = Number(arg('speed') ?? 4)
const caseName = arg('case')
const suite = arg('suite')

const names = Object.keys(CASES).filter((n) => {
  if (caseName) return n === caseName
  if (suite) return n.startsWith(`TC-${suite}`)
  return false
})

if (arg('list') || names.length === 0) {
  console.log('可用用例：')
  for (const [n, tc] of Object.entries(CASES)) {
    console.log(`  ${n.padEnd(7)} ${tc.title}  (时长 ${(tc.endMs / 1000).toFixed(0)}s)`)
  }
  console.log('\n用法：npm run demo -- --case TC-B2 [--speed 6] | --suite B')
  process.exit(0)
}

console.log(`pixelbar-one-look sim — ${names.length} 个用例，${speed}x 倍速\n`)
let failed = 0
for (const n of names) {
  const tc = CASES[n]
  console.log(`━━━ ${n} ${tc.title}`)
  const result = await runTimelineCase(tc, new ScaledClock(speed))
  for (const line of result.lines) console.log(`   ${line}`)
  if (result.failures.length > 0) {
    failed++
    for (const f of result.failures) console.log(`   ✗ ${f}`)
    console.log('   FAIL')
  } else {
    console.log('   PASS')
  }
  console.log('')
}
console.log(failed === 0 ? '全部通过' : `${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
