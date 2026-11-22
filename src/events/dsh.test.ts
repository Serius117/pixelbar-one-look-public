/**
 * dsh 归一化适配器测试 —— TC-DA 系列（测试设计.md §7.1，v0.2/PB.21）。
 * 全 mock：鸭子类型 ctx（on 记录器 + 手动触发），零 cordis 依赖，CI 可跑。
 * payload 为 Phase 1 默认假设（dsh调研.md §6.2），PB.23 真机标定后如有出入同步修订期望。
 */
import { describe, expect, it, vi } from 'vitest'
import { AggregationEngine } from '../lights/states'
import { attachDshEvents, createDshNormalizer, DSH_CHANNELS } from './dsh'
import type { InternalEvent } from './types'

const S = { id: 'ses_1' }
const A = { agent: { id: 'ag_1', session: S } } // 典型 agent 事件负载（agent.session.id 提取路径）
const SE = { id: 'ses_1' } // session/event 首参：Session 对象（pickSessionID 末位 p.id 候选提取）
const sev = (type: string, data: unknown = {}): unknown[] => [{ ...SE }, { type, seq: 5, time: 0, data }]

/** mock Cordis ctx：on 注册进 listeners（后者返回 disposer），登记顺序记入 calls */
function mockCtx(): {
  ctx: { on: (name: string, cb: (...args: unknown[]) => unknown) => () => void }
  listeners: Map<string, (...args: unknown[]) => unknown>
  calls: string[]
} {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const calls: string[] = []
  return {
    calls,
    listeners,
    ctx: {
      on: (name, cb) => {
        listeners.set(name, cb)
        calls.push(name)
        return () => {
          listeners.delete(name)
        }
      },
    },
  }
}

describe('createDshNormalizer · dsh 通道映射（TC-DA1，PB.23 实测版）', () => {
  it.each([
    ['session/created', [{ session: { id: 'ses_1', title: '我的任务' } }], { type: 'session.created', sessionID: 'ses_1', title: '我的任务' }],
    ['session/event', sev('turn/start'), { type: 'session.started', sessionID: 'ses_1' }],
    ['session/event', sev('turn/end'), { type: 'session.completed', sessionID: 'ses_1' }],
    ['session/event', sev('tool/call', { name: 'bash' }), { type: 'tool.started', sessionID: 'ses_1', text: 'bash' }],
    ['session/event', sev('step/start'), { type: 'tool.started', sessionID: 'ses_1', text: '执行中' }],
    ['session/event', sev('user/message'), { type: 'user.active', sessionID: 'ses_1' }],
    ['session/event', sev('session/title', { title: '真实项目名', messageSeqs: [], source: { kind: 'user' } }), { type: 'session.renamed', sessionID: 'ses_1', title: '真实项目名' }],
    ['session/event', sev('approval/asked', { toolName: 'bash' }), { type: 'permission.asked', sessionID: 'ses_1' }],
    ['session/event', sev('approval/decided', { outcome: 'allowed-once' }), { type: 'permission.resolved', sessionID: 'ses_1' }],
    ['agent/session-start', [{ ...A, source: 'user' }], { type: 'session.started', sessionID: 'ses_1' }],
    ['agent/step', [{ ...A, step: { tool: 'bash' } }], { type: 'tool.started', sessionID: 'ses_1', text: 'bash' }],
    ['tools/result', [{ name: 'bash', agent: { session: S } }, { ok: true }], { type: 'tool.started', sessionID: 'ses_1', text: 'bash' }],
    ['agent/request-error', [{ ...A, error: { message: 'boom' } }], { type: 'session.failed', sessionID: 'ses_1' }],
    ['agent/error', [A], { type: 'session.failed', sessionID: 'ses_1' }],
    ['approval/request', [{ agent: { session: S }, request: { kind: 'tool' } }], { type: 'permission.asked', sessionID: 'ses_1' }],
    ['agent/disposed', [A], { type: 'session.abandoned', sessionID: 'ses_1' }],
    ['agent/inbox/claimed', [A], { type: 'user.active', sessionID: 'ses_1' }],
  ] as Array<[string, unknown[], Record<string, unknown>]>)(
    '%s %j → %j',
    (channel, args, expected) => {
      expect(createDshNormalizer()(channel, args)).toEqual([expected])
    },
  )

  it('session/event 非映射类型（assistant/message、session/end-seed、approval/policy 等）→ 静默', () => {
    const n = createDshNormalizer()
    expect(n('session/event', sev('assistant/message', { text: 'hi' }))).toEqual([])
    expect(n('session/event', sev('session/end-seed'))).toEqual([])
    expect(n('session/event', sev('approval/policy', { policy: 'ask' }))).toEqual([])
    expect(n('session/event', sev('permission/preset', { preset: 'workspace-write' }))).toEqual([])
  })

  it('工作区路径 → project 字段（basename 浓缩，D13 别名兜底链）', () => {
    const out = createDshNormalizer()('agent/session-start', [
      { ...A, workspace: 'D:/projects/demo' },
    ])
    expect(out).toEqual([{ type: 'session.started', sessionID: 'ses_1', project: 'demo' }])
  })

  it('未知通道 → 静默空数组', () => {
    expect(createDshNormalizer()('agent/unknown-thing', [A])).toEqual([])
  })
})

describe('恒 next() 纪律（TC-DA2，详细设计 §10.4）', () => {
  it('approval/request 任何负载下 next 恰调用一次、返回值透传；畸形负载与下游异常都不影响转发', async () => {
    const { ctx, listeners } = mockCtx()
    const seen: InternalEvent[] = []
    attachDshEvents(ctx, (e) => seen.push(e))
    const cb = listeners.get('approval/request')!
    const payload = { agent: { session: S }, request: { kind: 'tool' } }

    // 正常负载：观察 + 转发
    const next1 = vi.fn(() => 'ANSWER')
    const r1 = await cb(payload, next1)
    expect(next1).toHaveBeenCalledTimes(1)
    expect(r1).toBe('ANSWER')
    expect(seen).toEqual([{ type: 'permission.asked', sessionID: 'ses_1' }])

    // 畸形负载（null）：观察空手而归，next 仍转发
    seen.length = 0
    const next2 = vi.fn(() => 'X')
    const r2 = await cb(null, next2)
    expect(next2).toHaveBeenCalledTimes(1)
    expect(r2).toBe('X')
    expect(seen).toEqual([])

    // 下游 emit 抛异常：next 仍必须转发（铁律 1——观察失败绝不截断审批）
    seen.length = 0
    const boom = vi.fn(() => {
      throw new Error('downstream boom')
    })
    attachDshEvents(ctx, boom)
    const cb2 = listeners.get('approval/request')!
    const next3 = vi.fn(() => 'Y')
    const r3 = await cb2(payload, next3)
    expect(next3).toHaveBeenCalledTimes(1)
    expect(r3).toBe('Y')
  })
})

describe('子 Agent 过滤 / 防御性解析（TC-DA3 / TC-DA4）', () => {
  it('TC-DA3 creator 非空（子 Agent）事件一律不聚合（D17 对应物）', () => {
    const n = createDshNormalizer()
    for (const channel of DSH_CHANNELS) {
      expect(n(channel, [{ creator: 'agent_parent', session: S }])).toEqual([])
    }
  })

  it('TC-DA4 畸形 payload（null/原始值/空对象/缺会话标识）→ 空数组，绝不抛', () => {
    const n = createDshNormalizer()
    const bads: unknown[] = [null, undefined, 42, 'x', [], {}, { session: 3 }, { agent: null }]
    for (const channel of DSH_CHANNELS) {
      for (const bad of bads) {
        const args = [bad] as readonly unknown[]
        expect(() => n(channel, args)).not.toThrow()
        expect(n(channel, args)).toEqual([])
      }
    }
  })
})

describe('attachDshEvents 接线（TC-DA5）', () => {
  it('注册 12 通道；disposer 注销后（宿主返回 disposer 场景）', () => {
    const { ctx, listeners, calls } = mockCtx()
    const seen: InternalEvent[] = []
    const detach = attachDshEvents(ctx, (e) => seen.push(e))
    expect([...calls].sort()).toEqual([...DSH_CHANNELS].sort())
    expect(listeners.size).toBe(DSH_CHANNELS.length)

    listeners.get('agent/session-start')!({ ...A })
    expect(seen.map((e) => e.type)).toEqual(['session.started'])

    detach()
    expect(listeners.size).toBe(0) // 宿主 disposer 已被调用
  })

  it('宿主 on 不返回 disposer：标志位兜底，detach 后 emit 不再触发', () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      on: (name: string, cb: (...args: unknown[]) => unknown) => {
        listeners.set(name, cb)
        return undefined
      },
    }
    const seen: InternalEvent[] = []
    const detach = attachDshEvents(ctx, (e) => seen.push(e))
    listeners.get('agent/session-start')!({ ...A })
    expect(seen.length).toBe(1)
    detach()
    seen.length = 0
    listeners.get('agent/session-start')!({ ...A }) // 宿主侧 listener 未注销，但标志位拦截
    expect(seen).toEqual([])
  })

  it('单通道注册抛异常：降级继续注册其余通道，attach 不抛', () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      on: (name: string, cb: (...args: unknown[]) => unknown) => {
        if (name === 'agent/step') throw new Error('host quirk')
        listeners.set(name, cb)
        return () => undefined
      },
    }
    expect(() => attachDshEvents(ctx, () => undefined)).not.toThrow()
    expect(listeners.size).toBe(DSH_CHANNELS.length - 1)
    expect(listeners.has('agent/step')).toBe(false)
  })
})

describe('引擎联动（TC-DA6 ~ DA10，跨 states.ts 断言）', () => {
  const feed = (n: ReturnType<typeof createDshNormalizer>, engine: AggregationEngine, channel: string, args: unknown[], now: number): void => {
    for (const e of n(channel, args)) engine.apply(e, now)
  }

  it('TC-DA6 session.created 播种 title；启动信号幂等（台账恰 1 条 working）', () => {
    const n = createDshNormalizer()
    const engine = new AggregationEngine()
    feed(n, engine, 'session/created', [{ session: { id: 'ses_1', title: '我的任务' } }], 1000)
    feed(n, engine, 'agent/session-start', [{ ...A, source: 'user' }], 1000)
    feed(n, engine, 'agent/session-start', [{ ...A, source: 'user' }], 1000) // 重复启动：engine 幂等
    expect(engine.stats()).toMatchObject({ working: 1, waiting: 0, error: 0, done: [] })
    expect(engine.alias('ses_1')).toBe('我的任务')
  })

  it('TC-DA7 agent/request-error → session.failed → error 态', () => {
    const n = createDshNormalizer()
    const engine = new AggregationEngine()
    feed(n, engine, 'agent/session-start', [A], 1000)
    feed(n, engine, 'agent/request-error', [{ ...A, error: { message: 'boom' } }], 2000)
    expect(engine.stats()).toMatchObject({ working: 0, error: 1 })
  })

  it('TC-DA8 session/event turn/end → session.completed → done 轮播入队', () => {
    const n = createDshNormalizer()
    const engine = new AggregationEngine()
    feed(n, engine, 'session/created', [{ session: { id: 'ses_1', title: '我的任务' } }], 1000)
    feed(n, engine, 'session/event', sev('turn/start'), 1000)
    feed(n, engine, 'session/event', sev('turn/end'), 3000)
    const st = engine.stats()
    expect(st.working).toBe(0)
    expect(st.done.length).toBe(1)
    expect(st.done[0]!.alias).toBe('我的任务')
  })

  it('TC-DA9 agent/disposed 打断兜底（R2 Phase 1）：未见终态 → abandoned；已见完成/失败 → 无事件', () => {
    // a) 未见终态 → 判打断
    const n1 = createDshNormalizer()
    expect(n1('agent/disposed', [A])).toEqual([{ type: 'session.abandoned', sessionID: 'ses_1' }])

    // b) 已见 turn/end → 正常收尾，无事件
    const n2 = createDshNormalizer()
    n2('session/event', sev('turn/end'))
    expect(n2('agent/disposed', [A])).toEqual([])

    // c) 已见 request-error → 无事件（防 abandoned 误清红灯——失败态须常驻到解决信号）
    const n3 = createDshNormalizer()
    n3('agent/request-error', [A])
    expect(n3('agent/disposed', [A])).toEqual([])

    // d) 引擎联动：working 会话被打断 → 台账移除回默认
    const n4 = createDshNormalizer()
    const engine = new AggregationEngine()
    feed(n4, engine, 'agent/session-start', [A], 1000)
    feed(n4, engine, 'agent/disposed', [A], 2000)
    expect(engine.stats().working).toBe(0)
  })

  it('TC-DA10 user/message / inbox/claimed → user.active → 完成队列清空（双通道幂等）', () => {
    const n = createDshNormalizer()
    const engine = new AggregationEngine()
    feed(n, engine, 'session/created', [{ session: { id: 'ses_1', title: '我的任务' } }], 1000)
    feed(n, engine, 'session/event', sev('turn/start'), 1000)
    feed(n, engine, 'session/event', sev('turn/end'), 3000)
    expect(engine.stats().done.length).toBe(1)
    feed(n, engine, 'session/event', sev('user/message'), 5000)
    expect(engine.stats().done).toEqual([])
    // live 通道同样清队（重复触发无害）
    feed(n, engine, 'session/event', sev('turn/start'), 6000)
    feed(n, engine, 'session/event', sev('turn/end'), 7000)
    feed(n, engine, 'agent/inbox/claimed', [A], 8000)
    expect(engine.stats().done).toEqual([])
  })

  it('TC-DA12 session/title 标题早到/晚到都落到完成别名（真实页签名，不是 S 序号）', () => {
    // a) 标题在 turn/end 前到达：完成时直接取 title
    const n1 = createDshNormalizer()
    const e1 = new AggregationEngine()
    feed(n1, e1, 'session/created', [{ session: { id: 'ses_1' } }], 1000)
    feed(n1, e1, 'session/event', sev('session/title', { title: '浏览工作目录内容及作用' }), 1100)
    feed(n1, e1, 'session/event', sev('turn/start'), 1200)
    feed(n1, e1, 'session/event', sev('turn/end'), 1300)
    expect(e1.stats().done[0]?.alias).toBe('浏览工作目录内容及作用')

    // b) 标题在 turn/end 后才到达：完成队列已入队，仍回写为真实标题
    const n2 = createDshNormalizer()
    const e2 = new AggregationEngine()
    feed(n2, e2, 'session/created', [{ session: { id: 'ses_1' } }], 1000)
    feed(n2, e2, 'session/event', sev('turn/start'), 1100)
    feed(n2, e2, 'session/event', sev('turn/end'), 1200)
    expect(e2.stats().done[0]?.alias).toBe('S1')
    feed(n2, e2, 'session/event', sev('session/title', { title: '安装 dsh-market' }), 1300)
    const agg = e2.aggregate(1400)
    expect(e2.stats().done[0]?.alias).toBe('安装 dsh-market')
    expect(agg.kind === 'done' && agg.text).toBe('安装 dsh-market 完成')
  })

  it('PB.33 turn 边界动态解析标题：变化才发 session.renamed，同一标题不重复', () => {
    let title = '手动改的名字'
    const n = createDshNormalizer({ resolveTitle: () => title })
    expect(n('session/event', sev('turn/start'))).toEqual([
      { type: 'session.renamed', sessionID: 'ses_1', title: '手动改的名字' },
      { type: 'session.started', sessionID: 'ses_1' },
    ])
    // turn/end 标题未变：不重复发 renamed
    expect(n('session/event', sev('turn/end'))).toEqual([
      { type: 'session.completed', sessionID: 'ses_1' },
    ])
    title = '又改了'
    expect(n('session/event', sev('turn/start'))).toEqual([
      { type: 'session.renamed', sessionID: 'ses_1', title: '又改了' },
      { type: 'session.started', sessionID: 'ses_1' },
    ])
  })

  it('PB.33 重启后旧会话：turn/start 动态取标题 → 完成别名正确', () => {
    const n = createDshNormalizer({ resolveTitle: () => 'pixelbar-one-look' })
    const e = new AggregationEngine()
    feed(n, e, 'session/event', sev('turn/start'), 1000)
    feed(n, e, 'session/event', sev('turn/end'), 2000)
    expect(e.stats().done[0]?.alias).toBe('pixelbar-one-look')
  })

  it('PB.36 ask_user_question → permission.asked；tool/result 按 callId 配对 → permission.resolved', () => {
    const n = createDshNormalizer()
    const call = sev('tool/call', { name: 'ask_user_question', callId: 'call_q1', arguments: {} })
    expect(n('session/event', call)).toEqual([{ type: 'permission.asked', sessionID: 'ses_1' }])
    const result = sev('tool/result', { message: { role: 'tool', toolCallId: 'call_q1' } })
    expect(n('session/event', result)).toEqual([{ type: 'permission.resolved', sessionID: 'ses_1' }])
  })

  it('PB.36 非提问的 tool/result 不会误清等待（callId 不匹配）', () => {
    const n = createDshNormalizer()
    n('session/event', sev('tool/call', { name: 'ask_user_question', callId: 'q1' }))
    expect(n('session/event', sev('tool/result', { message: { toolCallId: 'other' } }))).toEqual([
      { type: 'tool.started', sessionID: 'ses_1', text: '执行中' },
    ])
  })

  it('PB.36 引擎联动：提问期间 waiting=1；回答后回 working', () => {
    const n = createDshNormalizer()
    const e = new AggregationEngine()
    feed(n, e, 'session/created', [{ session: { id: 'ses_1', title: '确认清理' } }], 1000)
    feed(n, e, 'session/event', sev('tool/call', { name: 'ask_user_question', callId: 'q1' }), 1100)
    expect(e.stats()).toMatchObject({ waiting: 1, working: 0 })
    const agg = e.aggregate(1200)
    expect(agg.kind === 'waiting' && agg.text).toBe('确认清理 待批准')
    feed(n, e, 'session/event', sev('tool/result', { message: { toolCallId: 'q1' } }), 1300)
    expect(e.stats()).toMatchObject({ waiting: 0, working: 1 })
  })
})

describe('onRaw 原始事件观察口（TC-DA11，PB.22 新增）', () => {
  it('onRaw 先于 emit 收到 (channel, args)；onRaw 抛异常不断 emit 主链', () => {
    const { ctx, listeners } = mockCtx()
    const raws: Array<[string, number]> = []
    const seen: InternalEvent[] = []
    attachDshEvents(
      ctx,
      (e) => seen.push(e),
      (channel, args) => {
        raws.push([channel, args.length])
        if (raws.length === 1) throw new Error('raw observer boom') // 首次即抛：emit 仍必须收到
      },
    )
    listeners.get('agent/session-start')!({ ...A })
    expect(raws).toEqual([['agent/session-start', 1]])
    expect(seen.map((e) => e.type)).toEqual(['session.started'])
  })
})
