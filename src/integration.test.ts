/**
 * L2 集成测试 —— TC 用例矩阵全链（事件 → 状态机 → 调度 → MockTransport 帧序列断言）。
 * 时钟：VirtualClock 零真实等待（含 TC-C3 的 11 分钟虚拟推进）。
 */
import { describe, expect, it } from 'vitest'
import { VirtualClock } from './clock.ts'
import { PixelBarDevice } from './hid/device.ts'
import { MockTransport } from './hid/mock-device.ts'
import { SILENT_LOGGER } from './hid/types.ts'
import type { InternalEvent } from './events/types.ts'
import { OutputScheduler } from './lights/effects.ts'
import { GlanceLoop } from './lights/loop.ts'
import { AggregationEngine } from './lights/states.ts'
import { CASES } from './test-cases.ts'
import { moodResponseFrame, runTimelineCase } from './test-runner.ts'

describe('TC 用例矩阵（测试设计 §4）', () => {
  for (const [name, tc] of Object.entries(CASES)) {
    it(`${name} ${tc.title}`, async () => {
      const r = await runTimelineCase(tc)
      expect(r.failures, r.failures.join('\n')).toEqual([])
    })
  }
})

describe('TC-E2 中途 fatal：静默降级不崩（铁律 1）', () => {
  it('运行中写失败×3 → 设备 fatal close，管线继续运行零异常', async () => {
    const clock = new VirtualClock()
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const engine = new AggregationEngine()
    const sleepFn = (ms: number): Promise<void> =>
      new Promise<void>((r) => clock.setTimer(r, ms))
    let devP: Promise<PixelBarDevice | null> | null = null
    const provider = async (): Promise<PixelBarDevice | null> =>
      (devP ??= PixelBarDevice.fromTransport(transport, SILENT_LOGGER, { sleep: sleepFn }))
    const scheduler = new OutputScheduler(provider, SILENT_LOGGER)
    const loop = new GlanceLoop(engine, scheduler, clock)

    loop.start()
    await clock.advanceTo(0)
    loop.handleEvent({ type: 'tool.started', sessionID: 'S1', text: 'Edit A.tsx' })
    await clock.advanceTo(100)

    transport.failNextWrites = 999 // 模拟设备拔出
    loop.handleEvent({ type: 'session.completed', sessionID: 'S1' } satisfies InternalEvent)
    await clock.advanceTo(1_000)
    loop.handleEvent({ type: 'tool.started', sessionID: 'S2', text: 'Edit B.tsx' } satisfies InternalEvent)
    await clock.advanceTo(10_000)
    loop.stop()

    expect(transport.closed).toBe(true) // fatal 已触发 close
    // 到达此处 = 全程零未捕获异常
  })
})
