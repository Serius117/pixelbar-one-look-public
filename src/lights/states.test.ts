/**
 * AggregationEngine 单元测试 —— 纯逻辑锁定（优先级压缩/压制浮出/别名/字节预算/deadline）。
 */
import { describe, expect, it } from 'vitest'
import {
  AggregationEngine,
  DONE_ENTRY_TTL_MS,
  DONE_RIPPLE_MS,
} from './states.ts'
import type { InternalEvent } from '../events/types.ts'

const ev = {
  started: (sid: string, project?: string): InternalEvent => ({ type: 'session.started', sessionID: sid, project }),
  tool: (sid: string, text: string, project?: string): InternalEvent => ({ type: 'tool.started', sessionID: sid, text, project }),
  asked: (sid: string, project?: string): InternalEvent => ({ type: 'permission.asked', sessionID: sid, project }),
  resolved: (sid: string): InternalEvent => ({ type: 'permission.resolved', sessionID: sid }),
  failed: (sid: string, project?: string): InternalEvent => ({ type: 'session.failed', sessionID: sid, project }),
  completed: (sid: string, project?: string): InternalEvent => ({ type: 'session.completed', sessionID: sid, project }),
  abandoned: (sid: string): InternalEvent => ({ type: 'session.abandoned', sessionID: sid }),
  active: (): InternalEvent => ({ type: 'user.active' }),
}

describe('优先级压缩与压制浮出', () => {
  it('waiting > error > working > done > idle', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A'), 0) // done 队列
    e.apply(ev.tool('B', 'x'), 1) // working
    e.apply(ev.failed('C'), 2) // error
    e.apply(ev.asked('D'), 3) // waiting
    expect(e.aggregate(4).kind).toBe('waiting')
    e.apply(ev.resolved('D'), 5)
    expect(e.aggregate(6).kind).toBe('error')
    e.apply(ev.tool('C', 'retry'), 7) // error 解决信号：新事件
    expect(e.aggregate(8).kind).toBe('working')
    e.apply(ev.completed('D'), 8) // D 会话也结束
    e.apply(ev.completed('B'), 9)
    e.apply(ev.completed('C'), 10)
    expect(e.aggregate(11).kind).toBe('done') // 队列还有 A
    e.apply(ev.active(), 12)
    expect(e.aggregate(13).kind).toBe('idle')
  })

  it('working 同级取最近活跃', () => {
    const e = new AggregationEngine()
    e.apply(ev.tool('A', 'Edit A'), 0)
    e.apply(ev.tool('B', 'Edit B'), 2_000)
    const agg = e.aggregate(3_000)
    expect(agg).toEqual({ kind: 'working', text: 'Edit B' })
  })

  it('error 被 waiting 压制，解除后浮出', () => {
    const e = new AggregationEngine()
    e.apply(ev.failed('A'), 0)
    expect(e.aggregate(1).kind).toBe('error')
    e.apply(ev.asked('B'), 2)
    expect(e.aggregate(3).kind).toBe('waiting')
    e.apply(ev.resolved('B'), 4)
    expect(e.aggregate(5).kind).toBe('error') // 浮出
  })

  it('user.active 是 error 解决信号（D09）', () => {
    const e = new AggregationEngine()
    e.apply(ev.failed('A'), 0)
    e.apply(ev.active(), 1)
    expect(e.aggregate(2).kind).toBe('idle')
  })

  it('多个 waiting 计数', () => {
    const e = new AggregationEngine()
    e.apply(ev.asked('A'), 0)
    e.apply(ev.asked('B'), 1)
    const agg = e.aggregate(2)
    expect(agg.kind).toBe('waiting')
    if (agg.kind === 'waiting') expect(agg.text).toBe('2个待批准')
  })
})

describe('别名（D13：title→项目名→S 序号）', () => {
  it('无 project 无 title → S 序号兜底', () => {
    const e = new AggregationEngine()
    e.apply(ev.asked('A'), 0)
    const agg = e.aggregate(1)
    expect(agg.kind === 'waiting' && agg.text).toBe('S1 待批准')
  })

  it('project（D13 项目名）优先于序号', () => {
    const e = new AggregationEngine()
    e.apply(ev.asked('A', 'pixelbar-bridge'), 0)
    const agg = e.aggregate(1)
    // 双预算：待批准 3 字 → 别名截 12 字符 + 空格 + 词 = 16 字符恰好（状态词完整）
    expect(agg.kind === 'waiting' && agg.text).toBe('pixelbar-bri 待批准')
  })

  it('title 优先于 project', () => {
    const e = new AggregationEngine()
    e.setSessionTitle('A', '修复登录页CSS')
    e.apply(ev.failed('A', 'pixelbar-bridge'), 0)
    const agg = e.aggregate(1)
    expect(agg.kind === 'error' && agg.text).toBe('修复登录页CSS 出错')
  })

  it('session.renamed 事件 → 台账 title 更新（R3：GUI 页签重命名，别名随之变化）', () => {
    const e = new AggregationEngine()
    e.apply(ev.asked('A', 'pixelbar-bridge'), 0)
    expect(e.aggregate(1).kind === 'waiting' && e.aggregate(1).text).toBe('pixelbar-bri 待批准')
    e.apply({ type: 'session.renamed', sessionID: 'A', title: '修复登录页CSS' }, 1)
    const agg = e.aggregate(2)
    expect(agg.kind === 'waiting' && agg.text).toBe('修复登录页CSS 待批准')
  })

  it('completed 携带 project → 轮播别名用项目名', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A', 'demo-app'), 0)
    const agg = e.aggregate(1)
    expect(agg.kind === 'done' && agg.text).toBe('demo-app 完成')
  })

  it('超字节项目名：别名按预算截断、状态词完整（48B 拼接后整体）', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A', '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'), 0)
    const agg = e.aggregate(1)
    expect(agg.kind === 'done' && agg.text.endsWith('完成')).toBe(true)
    expect(new TextEncoder().encode(agg.kind === 'done' ? agg.text : '').length).toBeLessThanOrEqual(48)
  })
})

describe('会话标题与子会话（v0.1.2：标题别名 + 隐藏子会话隔离）', () => {
  it('完成轮播别名：title 优先于 project（R3 落地到 done 路径）', () => {
    const e = new AggregationEngine()
    e.registerSession({ id: 'A', title: '修复登录页', parentID: null, project: 'pixelbar-one-look' })
    e.apply(ev.completed('A', 'pixelbar-one-look'), 0)
    const agg = e.aggregate(1)
    expect(agg.kind === 'done' && agg.text).toBe('修复登录页 完成')
  })

  it('session.created 携带 title → 后续完成使用标题', () => {
    const e = new AggregationEngine()
    e.apply({ type: 'session.created', sessionID: 'A', title: '状态灯插件' }, 0)
    e.apply(ev.completed('A', 'pixelbar-one-look'), 1)
    const agg = e.aggregate(2)
    expect(agg.kind === 'done' && agg.text).toBe('状态灯插件 完成')
  })

  it('子会话（parentID）事件不参与聚合：无 working、无幽灵完成', () => {
    const e = new AggregationEngine()
    e.registerSession({ id: 'child', parentID: 'root', title: '标题生成' })
    e.apply(ev.started('child'), 0)
    expect(e.aggregate(1).kind).toBe('idle')
    e.apply(ev.completed('child'), 2)
    expect(e.aggregate(3).kind).toBe('idle')
    expect(e.stats().done).toEqual([])
  })

  it('根会话不受子会话隔离影响', () => {
    const e = new AggregationEngine()
    e.registerSession({ id: 'root', parentID: null, title: '主线' })
    e.apply(ev.started('root'), 0)
    expect(e.aggregate(1).kind).toBe('working')
  })
})

describe('done 队列与 deadline', () => {
  it('stats()：会话状态计数 + 完成队列条目（D14 控制台）', () => {
    const e = new AggregationEngine()
    e.apply(ev.tool('A', 'x', 'proj-a'), 0)
    e.apply(ev.asked('B', 'proj-b'), 1)
    e.apply(ev.completed('C', 'proj-c'), 2)
    const s = e.stats()
    expect(s.working).toBe(1)
    expect(s.waiting).toBe(1)
    expect(s.error).toBe(0)
    expect(s.done).toEqual([{ alias: 'proj-c', ageMs: expect.any(Number) }])
  })
  it('celebrating 5s 窗口', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A'), 1_000)
    expect(e.aggregate(2_000).kind === 'done' && e.aggregate(2_000).celebrating).toBe(true)
    expect(e.aggregate(1_000 + DONE_RIPPLE_MS).celebrating).toBe(false)
  })

  it('条目 10min 过期自动清', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A'), 0)
    expect(e.aggregate(DONE_ENTRY_TTL_MS - 1).kind).toBe('done')
    expect(e.aggregate(DONE_ENTRY_TTL_MS + 1).kind).toBe('idle')
  })

  it('nextDeadline：轮播槽 3s 对齐 + 涟漪结束时刻', () => {
    const e = new AggregationEngine()
    e.apply(ev.completed('A'), 1_000)
    const now = 4_000
    const d = e.nextDeadline(now)
    expect(d).not.toBeNull()
    expect(d!).toBeGreaterThanOrEqual(now)
    // 轮播槽：6000；涟漪结束：6000（1000+5000）——都 > now
    const rippleEnd = e.nextDeadline(5_500)
    expect(rippleEnd).not.toBeNull()
  })

  it('空态/working 态无聚合层 deadline', () => {
    const e = new AggregationEngine()
    expect(e.nextDeadline(0)).toBeNull()
    e.apply(ev.tool('A', 'x'), 0)
    expect(e.nextDeadline(1)).toBeNull()
  })
})
