/**
 * scripts/device-scenarios.ts —— 真机灯效场景检查（用户命令触发，代理不代跑）。
 *
 * 驱动真实 engine + scheduler + GlanceLoop（非 mock 状态机）→ 真实 PixelBar 输出，
 * 按顺序演示：空闲 / 执行中 / 待批准 / 出错 / 完成 / 多会话抢占 / 收尾。
 *
 * 用法（建议在 opencode 空闲时运行，避免插件同时写设备）：
 *   npm run scenarios
 *   npm run scenarios -- --project 演示项目   # 自定义别名
 *
 * 结束时自动清屏 + 回空闲呼吸；全程约 40s，有限时长、无人值守。
 * 目视清单在末尾打印——脚本只能保证帧已发出，观感需人眼验收。
 */
import { systemClock } from '../src/clock.ts'
import { PixelBarDevice } from '../src/hid/device.ts'
import { CMD, pixelClockPayload } from '../src/hid/protocol.ts'
import type { DeviceLogger } from '../src/hid/types.ts'
import { OutputScheduler } from '../src/lights/effects.ts'
import { GlanceLoop } from '../src/lights/loop.ts'
import { AggregationEngine } from '../src/lights/states.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const PROJECT = arg('project') ?? '演示项目'

const warnings: string[] = []
const logger: DeviceLogger = {
  warn: (msg, err) => {
    const line = err ? `${msg} — ${String(err)}` : msg
    warnings.push(line)
    console.log(`  [warn] ${line}`)
  },
  debug: (msg) => console.log(`  [debug] ${msg}`),
}

function section(index: number, total: number, title: string, expect: string, holdMs: number): void {
  console.log('')
  console.log('─'.repeat(64))
  console.log(`场景 ${index}/${total} · ${title}（保持 ${(holdMs / 1000).toFixed(1)}s）`)
  console.log(`预期：${expect}`)
  console.log('─'.repeat(64))
}

async function main(): Promise<number> {
  console.log(`pixelbar-one-look 真机场景检查 — 别名="${PROJECT}"（约 40s，结束时自动清屏）`)
  const device = await PixelBarDevice.open(logger)
  if (!device) {
    console.error('设备打开失败：node-hid 不可用 / 设备被占用 / 0x6A 查询失败（先跑 npm run smoke -- --stage open）')
    return 1
  }
  console.log(`设备就绪：arrayIndex=${device.arrayIndex}`)

  const engine = new AggregationEngine()
  const scheduler = new OutputScheduler(async () => device, logger)
  const loop = new GlanceLoop(engine, scheduler, systemClock)
  loop.start()
  await sleep(1_200)

  section(1, 6, '空闲', '淡青呼吸灯，灯屏无文字', 2_500)
  await sleep(2_500)

  section(2, 6, '执行中', '流光逐影（动效），灯屏无文字（D13）', 4_000)
  loop.handleEvent({ type: 'session.started', sessionID: 'A', project: PROJECT })
  await sleep(4_000)

  section(3, 6, '待批准', `动态光影 + 「${PROJECT} 待批准」文字（10s 后自动清屏）`, 6_000)
  loop.handleEvent({ type: 'permission.asked', sessionID: 'A', project: PROJECT })
  await sleep(6_000)

  section(4, 6, '出错', `纯红 + 「${PROJECT} 出错」文字`, 5_000)
  loop.handleEvent({ type: 'permission.resolved', sessionID: 'A' })
  loop.handleEvent({ type: 'session.failed', sessionID: 'A', project: PROJECT })
  await sleep(5_000)

  section(5, 6, '完成', '炫彩涟漪 5s → 呼吸 + 「演示完成 完成」文字', 7_000)
  loop.handleEvent({ type: 'session.abandoned', sessionID: 'A' })
  engine.registerSession({ id: 'B', title: '演示完成' })
  loop.handleEvent({ type: 'session.completed', sessionID: 'B', project: PROJECT })
  await sleep(7_000)

  section(6, 6, '多会话抢占', '动态光影抢占 + 「会话D 待批准」；解决后流光浮出', 8_000)
  engine.registerSession({ id: 'C', title: '会话C' })
  engine.registerSession({ id: 'D', title: '会话D' })
  loop.handleEvent({ type: 'session.started', sessionID: 'C', project: '演示' })
  loop.handleEvent({ type: 'session.started', sessionID: 'D', project: '演示' })
  await sleep(1_500)
  loop.handleEvent({ type: 'permission.asked', sessionID: 'D', project: '演示' })
  await sleep(4_500)
  loop.handleEvent({ type: 'permission.resolved', sessionID: 'D' })
  await sleep(2_000)

  console.log('')
  console.log('收尾：清屏 + 回空闲呼吸')
  loop.handleEvent({ type: 'user.active' })
  loop.handleEvent({ type: 'session.abandoned', sessionID: 'C' })
  loop.handleEvent({ type: 'session.abandoned', sessionID: 'D' })
  await sleep(800)
  await device.sendFrame(CMD.PIXEL_SET, pixelClockPayload([0x1c, 0xff, 0xf8]))
  loop.stop()
  device.close()

  const writeWarns = warnings.filter((w) => w.includes('hid write failed') || w.includes('marked unusable'))
  console.log('')
  console.log(writeWarns.length === 0 ? 'PASS — 全部场景帧已发出' : `FAIL — HID 写入告警 ${writeWarns.length} 条`)
  console.log('请逐项目视确认：')
  for (const item of [
    '1 空闲：淡青呼吸',
    '2 执行中：流光逐影、无文字',
    '3 待批准：动态光影 + 待批准文字',
    '4 出错：纯红 + 出错文字',
    '5 完成：涟漪 5s → 呼吸 + 完成文字',
    '6 多会话：待批准抢占、解决后切回流光',
  ]) {
    console.log(`  [ ] ${item}`)
  }
  return writeWarns.length === 0 ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    console.error('场景检查异常：', err)
    process.exitCode = 1
  })
