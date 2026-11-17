/**
 * MockTransport —— HidTransport 的测试替身（CI 零硬件铁律）。
 * 可编程：写入延迟（验队列串行/三连发时序）、连续失败（验降级/fatal）、响应队列（验 queryMood）。
 */
import type { HidTransport } from './types.ts'

export interface WriteRecord {
  data: Uint8Array
  start: number
  end: number
}

export class MockTransport implements HidTransport {
  /** 成功写入的帧（断言内容用） */
  readonly writes: Uint8Array[] = []
  /** 成功写入的时间线（断言串行性/三连发间隔用） */
  readonly timeline: WriteRecord[] = []
  /** 接下来 N 次写入抛错（失败不记录进 writes/timeline） */
  failNextWrites = 0
  /** read() 依次返回的响应帧，耗尽返回 null（模拟超时） */
  readonly readQueue: Uint8Array[] = []
  /** 每次成功写入消耗一个延迟（依次 shift）；耗尽则 0 延迟 */
  readonly writeDelays: number[] = []
  closed = false

  async write(data: Uint8Array): Promise<number> {
    if (this.closed) throw new Error('mock transport closed')
    if (this.failNextWrites > 0) {
      this.failNextWrites--
      throw new Error(`mock write failure (remaining ${this.failNextWrites})`)
    }
    const start = Date.now()
    const delay = this.writeDelays.shift() ?? 0
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    const end = Date.now()
    this.writes.push(data)
    this.timeline.push({ data, start, end })
    return data.length
  }

  async read(_timeoutMs: number): Promise<Uint8Array | null> {
    if (this.closed) return null
    return this.readQueue.shift() ?? null
  }

  close(): void {
    this.closed = true
  }
}
