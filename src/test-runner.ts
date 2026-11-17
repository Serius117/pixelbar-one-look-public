/**
 * TimelineRunner —— TC 用例的共享执行器（integration.test.ts 与 tools/sim.ts 共用，不依赖 vitest）。
 * 装配完整真实管线：engine + scheduler + GlanceLoop + MockTransport，事件经时间轴注入。
 */
import { VirtualClock } from './clock.ts'
import { PixelBarDevice } from './hid/device.ts'
import { MockTransport } from './hid/mock-device.ts'
import { SILENT_LOGGER } from './hid/types.ts'
import { decodeFrames } from './hid/virtual-pixelbar.ts'
import { OutputScheduler } from './lights/effects.ts'
import { GlanceLoop } from './lights/loop.ts'
import { AggregationEngine } from './lights/states.ts'
import { CASES, type TimelineCase } from './test-cases.ts'

export interface TimelineClock {
  now(): number
  setTimer(fn: () => void, ms: number): () => void
  advanceTo(ms: number): Promise<void>
}

export function moodResponseFrame(arrayIndex = 0x20, currentIndex = 0x03): Uint8Array {
  const payload = [arrayIndex, currentIndex, 1, 0x1c, 0xff, 0xf8, 0x64, 0x08]
  const f = new Uint8Array(64)
  f[0] = 0x2f
  f[1] = 0xbb
  f[2] = 0xec
  f[3] = 0x6a
  f[4] = payload.length >> 8
  f[5] = payload.length & 0xff
  f.set(payload, 6)
  return f
}

export interface RunResult {
  lines: string[]
  failures: string[]
}

export async function runTimelineCase(
  tc: TimelineCase,
  clock?: TimelineClock,
): Promise<RunResult> {
  const c: TimelineClock = clock ?? new VirtualClock()
  const transport = new MockTransport()
  if (!tc.noDevice) transport.readQueue.push(moodResponseFrame())

  const engine = new AggregationEngine()
  const sleepFn = (ms: number): Promise<void> => new Promise<void>((r) => c.setTimer(r, ms))
  let devP: Promise<PixelBarDevice | null> | null = null
  const provider = async (): Promise<PixelBarDevice | null> =>
    (devP ??= PixelBarDevice.fromTransport(transport, SILENT_LOGGER, { sleep: sleepFn }))

  const scheduler = new OutputScheduler(provider, SILENT_LOGGER)
  const loop = new GlanceLoop(engine, scheduler, c)
  tc.setup?.({ engine })

  loop.start()
  for (const step of tc.timeline) {
    await c.advanceTo(step.atMs)
    loop.handleEvent(step.event)
    await c.advanceTo(c.now()) // flush：事件触发的 pump 在事件时刻立即执行（celebrating 等时敏逻辑不漂移）
  }
  await c.advanceTo(tc.endMs)
  loop.stop()

  const lines = decodeFrames(transport.writes).filter((l) => l !== 'MOOD_QUERY')
  const failures: string[] = []

  if (tc.expect) {
    if (lines.length !== tc.expect.length || lines.some((l, i) => l !== tc.expect![i])) {
      failures.push(`帧序列不符\n  actual:   ${JSON.stringify(lines)}\n  expected: ${JSON.stringify(tc.expect)}`)
    }
  }
  if (tc.expectContains) {
    let from = 0
    for (const want of tc.expectContains) {
      const idx = lines.indexOf(want, from)
      if (idx === -1) {
        failures.push(`缺失子序列（在 #${from} 后）：${want}\n  actual: ${JSON.stringify(lines)}`)
        break
      }
      from = idx + 1
    }
  }
  return { lines, failures }
}

export const TIMELINE_CASES = CASES
