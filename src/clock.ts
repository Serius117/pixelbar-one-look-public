/**
 * 时钟抽象 —— 可测性三注入点之一（测试设计 §2）。
 * 60s 重复窗口 / 10s 窗口 / 10min 过期 / 三连发 30ms 间隔全部经此时钟，
 * 测试用 VirtualClock 手动推进（零真实等待），sim 演示用 ScaledClock 倍速。
 */

export interface Clock {
  now(): number
  /** 定时器注册；返回取消函数。virtual 场景下由 VirtualClock 推进触发 */
  setTimer(fn: () => void, ms: number): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}

const flushMicrotasks = async (): Promise<void> => {
  // setImmediate：等待 pump 的 async 写入链（microtask + macrotask 轮）完成；
  // 轮数取宽裕值：三连发/队列链较深，vitest worker 下偶发需要更多轮
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}

/** 手动推进的虚拟时钟（L2 测试）：advanceTo 依次触发到期定时器并等待 async 链 */
export class VirtualClock implements Clock {
  private t = 0
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  private nextId = 0

  now = (): number => this.t
  setTimer = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.nextId
    this.timers.push({ id, at: this.t + ms, fn })
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id)
    }
  }

  /** 推进到 target（虚拟毫秒），途中触发所有到期定时器（触发后移除），每次触发后等待 async 链 */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x.id !== due.id) // 触发即移除，防重复触发死循环
      this.t = due.at
      due.fn()
      await flushMicrotasks()
    }
    if (target > this.t) this.t = target
    await flushMicrotasks()
  }
}

/** 倍速时钟（L3 sim 演示）：虚拟时间 = 真实流逝 × speed，定时器按 1/speed 压缩 */
export class ScaledClock implements Clock {
  private readonly realStart = Date.now()
  private readonly vStart = 0
  private readonly speed: number

  constructor(speed = 1) {
    this.speed = speed
  }

  now = (): number => this.vStart + (Date.now() - this.realStart) * this.speed
  setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = setTimeout(fn, Math.max(1, ms / this.speed))
    return () => clearTimeout(t)
  }

  /** 真实等待 (target-now)/speed 毫秒（sim 时间轴推进） */
  async advanceTo(target: number): Promise<void> {
    const ms = Math.max(0, (target - this.now()) / this.speed)
    if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms))
    await flushMicrotasks()
  }
}
