/**
 * GlanceLoop —— 事件泵 + deadline 循环（index.ts / sim 工具 / L2 测试三处共用的装配线）。
 * 时钟注入（Clock）：测试零真实等待，sim 倍速，入口层系统时钟。
 *
 * 循环语义：
 * - 事件到达 → engine.apply → pump（合并同 tick 多事件）
 * - pump：aggregate → scheduler.update → 取 min(engine/scheduler deadline) 挂定时器
 * - 无 deadline（纯 working/idle 静默态）则定时器停，等下一个事件唤醒（零空转）
 */
import type { Clock, } from '../clock.ts'
import type { InternalEvent } from '../events/types.ts'
import type { AggregationEngine } from './states.ts'
import type { OutputScheduler } from './effects.ts'

export class GlanceLoop {
  private cancel: (() => void) | null = null
  private pumping = false
  private pumpQueued = false
  private readonly engine: AggregationEngine
  private readonly scheduler: OutputScheduler
  private readonly clock: Clock

  constructor(engine: AggregationEngine, scheduler: OutputScheduler, clock: Clock) {
    this.engine = engine
    this.scheduler = scheduler
    this.clock = clock
  }

  handleEvent(ev: InternalEvent): void {
    this.engine.apply(ev, this.clock.now())
    this.schedulePump()
  }

  /** 启动：立即泵一次（初始 idle 呼吸灯上电） */
  start(): void {
    this.schedulePump()
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
  }

  private schedulePump(): void {
    if (this.pumping) {
      this.pumpQueued = true
      return
    }
    this.pumpQueued = true
    queueMicrotask(() => void this.pump())
  }

  private async pump(): Promise<void> {
    this.pumping = true
    try {
      while (this.pumpQueued) {
        this.pumpQueued = false
        const now = this.clock.now()
        await this.scheduler.update(this.engine.aggregate(now), now)
        const candidates = [
          this.engine.nextDeadline(now),
          this.scheduler.nextDeadline(now),
        ].filter((t): t is number => t !== null && t > now)
        this.cancel?.()
        this.cancel = null
        if (candidates.length > 0) {
          const next = Math.min(...candidates)
          const ms = Math.max(1, next - this.clock.now())
          this.cancel = this.clock.setTimer(() => this.schedulePump(), ms)
        }
      }
    } finally {
      this.pumping = false
    }
  }
}
