/**
 * 归一化适配器测试 —— v2 实测定稿形态（@opencode/client 2.3.0 types.d.ts）+ v1 草案兼容。
 * 事件顶层 {type, data}（data 携带 sessionID 等载荷）。
 */
import { describe, expect, it } from 'vitest'
import { AggregationEngine } from '../lights/states'
import { basename, createOpencodeNormalizer, normalizeOpencodeEvent } from './opencode'
import type { InternalEvent } from './types'

const ev = (type: string, data: unknown): { type: string; data: unknown } => ({ type, data })

describe('normalizeOpencodeEvent · v2 实测形态', () => {
  it('permission.asked → permission.asked', () => {
    const out = normalizeOpencodeEvent(
      ev('permission.asked', { id: 'perm_1', sessionID: 'ses_1', action: 'bash', resources: ['*'] }),
    )
    expect(out).toEqual([{ type: 'permission.asked', sessionID: 'ses_1' }])
  })

  it('permission.replied → permission.resolved', () => {
    const out = normalizeOpencodeEvent(
      ev('permission.replied', { sessionID: 'ses_1', requestID: 'perm_1', reply: 'allow' }),
    )
    expect(out).toEqual([{ type: 'permission.resolved', sessionID: 'ses_1' }])
  })

  it('session.tool.called → tool.started（input 内容摘要：文件取 basename）', () => {
    const out = normalizeOpencodeEvent(
      ev('session.tool.called', {
        sessionID: 'ses_1',
        id: 'call_abc123',
        input: { filePath: 'src/components/Login.tsx' },
        executed: false,
      }),
    )
    expect(out).toEqual([{ type: 'tool.started', sessionID: 'ses_1', text: 'Login.tsx' }])
  })

  it('session.tool.called bash → 命令前两词', () => {
    const out = normalizeOpencodeEvent(
      ev('session.tool.called', { sessionID: 'ses_1', id: 'call_x', input: { command: 'npm test --watch' } }),
    )
    expect(out).toEqual([{ type: 'tool.started', sessionID: 'ses_1', text: 'npm test' }])
  })

  it('session.tool.called url → hostname', () => {
    const out = normalizeOpencodeEvent(
      ev('session.tool.called', { sessionID: 'ses_1', id: 'call_x', input: { url: 'http://127.0.0.1:18789/state' } }),
    )
    expect(out).toEqual([{ type: 'tool.started', sessionID: 'ses_1', text: '127.0.0.1' }])
  })

  it('session.tool.called 无可读输入 → 执行中（callID 不显示）', () => {
    const out = normalizeOpencodeEvent(
      ev('session.tool.called', { sessionID: 'ses_1', id: 'call_x', input: {} }),
    )
    expect(out).toEqual([{ type: 'tool.started', sessionID: 'ses_1', text: '执行中' }])
  })

  it('session.execution.started → session.started（D13：思考阶段即亮流光）', () => {
    expect(normalizeOpencodeEvent(ev('session.execution.started', { sessionID: 'ses_1' }))).toEqual([
      { type: 'session.started', sessionID: 'ses_1' },
    ])
  })

  it('事件 location → project 字段（D13：项目名别名）', () => {
    const out = normalizeOpencodeEvent({
      type: 'session.execution.succeeded',
      location: { directory: 'D:\\projects\\demo' },
      data: { sessionID: 'ses_1' },
    })
    expect(out).toEqual([{ type: 'session.completed', sessionID: 'ses_1', project: 'demo' }])
  })

  it('session.execution.succeeded → session.completed', () => {
    expect(normalizeOpencodeEvent(ev('session.execution.succeeded', { sessionID: 'ses_1' }))).toEqual([
      { type: 'session.completed', sessionID: 'ses_1' },
    ])
  })

  it('session.execution.failed → session.failed', () => {
    expect(normalizeOpencodeEvent(ev('session.execution.failed', { sessionID: 'ses_1', error: {} }))).toEqual([
      { type: 'session.failed', sessionID: 'ses_1' },
    ])
  })

  it('session.renamed → session.renamed（R3：GUI 页签重命名）', () => {
    expect(normalizeOpencodeEvent(ev('session.renamed', { sessionID: 'ses_1', title: '修复登录页' }))).toEqual([
      { type: 'session.renamed', sessionID: 'ses_1', title: '修复登录页' },
    ])
  })

  it('session.created → title/parentID/project（自动标题 + 子会话识别）', () => {
    const out = normalizeOpencodeEvent({
      type: 'session.created',
      location: { directory: 'D:\\Code\\pixelbar-one-look' },
      data: { sessionID: 'ses_child', title: '调试状态灯', parentID: 'ses_root' },
    })
    expect(out).toEqual([
      {
        type: 'session.created',
        sessionID: 'ses_child',
        title: '调试状态灯',
        parentID: 'ses_root',
        project: 'pixelbar-one-look',
      },
    ])
  })

  it('session.created 无 parentID（根会话）→ 不输出 parentID 字段', () => {
    const out = normalizeOpencodeEvent(ev('session.created', { sessionID: 'ses_root', title: '主线' }))
    expect(out).toEqual([{ type: 'session.created', sessionID: 'ses_root', title: '主线' }])
  })

  it('session.renamed 缺 title → 静默忽略', () => {
    expect(normalizeOpencodeEvent(ev('session.renamed', { sessionID: 'ses_1' }))).toEqual([])
  })

  it('session.execution.interrupted → abandoned（D13：回默认不庆祝）', () => {
    expect(
      normalizeOpencodeEvent(ev('session.execution.interrupted', { sessionID: 'ses_1', reason: 'user' })),
    ).toEqual([{ type: 'session.abandoned', sessionID: 'ses_1' }])
  })

  it('session.inbox.enqueued → user.active', () => {
    expect(normalizeOpencodeEvent(ev('session.inbox.enqueued', { sessionID: 'ses_1' }))).toEqual([
      { type: 'user.active', sessionID: 'ses_1' },
    ])
  })

  it('高频流事件（reasoning/text delta）静默忽略', () => {
    expect(normalizeOpencodeEvent(ev('session.text.delta', { sessionID: 's', delta: 'x' }))).toEqual([])
    expect(normalizeOpencodeEvent(ev('session.reasoning.delta', { sessionID: 's' }))).toEqual([])
    expect(normalizeOpencodeEvent(ev('project.updated', { id: 'p1' }))).toEqual([])
  })

  it('未知/空事件/缺 sessionID → 静默忽略（零 crash）', () => {
    expect(normalizeOpencodeEvent({ type: 'future.unknown', data: {} })).toEqual([])
    expect(normalizeOpencodeEvent(null)).toEqual([])
    expect(normalizeOpencodeEvent(ev('session.execution.succeeded', {}))).toEqual([])
    expect(normalizeOpencodeEvent({ data: { sessionID: 'x' } })).toEqual([])
  })
})

describe('normalizeOpencodeEvent · v1 草案形态兼容', () => {
  it('permission.updated（properties + pending）→ permission.asked', () => {
    const out = normalizeOpencodeEvent({
      type: 'permission.updated',
      properties: { sessionID: 'abc', status: 'pending' },
    })
    expect(out).toEqual([{ type: 'permission.asked', sessionID: 'abc' }])
  })

  it('message.part.updated（tool part）→ tool.started', () => {
    const out = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: { sessionID: 'abc', part: { type: 'tool', tool: 'edit' } },
    })
    expect(out).toEqual([{ type: 'tool.started', sessionID: 'abc', text: 'edit' }])
  })

  it('session.idle → session.completed', () => {
    expect(normalizeOpencodeEvent(ev('session.idle', { sessionID: 'abc' }))).toEqual([
      { type: 'session.completed', sessionID: 'abc' },
    ])
  })
})

describe('basename（D08 规则式浓缩）', () => {
  it.each([
    ['src/components/Login.tsx', 'Login.tsx'],
    ['D:\\a\\b\\foo.py', 'foo.py'],
    ['README.md', 'README.md'],
  ])('%s → %s', (input, expected) => {
    expect(basename(input)).toBe(expected)
  })
})

describe('后台工作追踪（PB.31：轮次结束但后台脚本仍在跑 → 灯效保持执行中）', () => {
  // 数据形态（持久化日志 2026-11-18 实测）：shell.created data={info:{id,metadata:{sessionID}}}；
  // shell.exited/deleted data={id}
  const shellCreated = (shId: string, sid: string) =>
    ev('shell.created', { info: { id: shId, status: 'running', command: 'python job.py', metadata: { sessionID: sid } } })
  const shellExited = (shId: string) => ev('shell.exited', { id: shId, exit: 0, status: 'exited' })
  const shellDeleted = (shId: string) => ev('shell.deleted', { id: shId })
  const succeeded = (sid: string) => ev('session.execution.succeeded', { sessionID: sid })
  const started = (sid: string) => ev('session.execution.started', { sessionID: sid })
  const interrupted = (sid: string) => ev('session.execution.interrupted', { sessionID: sid, reason: 'user' })

  /** 手动调度注入：fire() 触发宽限到点 */
  function manualClock() {
    let fire: (() => void) | null = null
    return {
      schedule: (fn: () => void, _ms: number) => {
        fire = fn
        return () => {
          if (fire === fn) fire = null
        }
      },
      fire: () => {
        const f = fire
        fire = null
        f?.()
      },
    }
  }

  it('后台 shell 存活时 succeeded 被抑制（灯效保持 working），completed 不发出', () => {
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ onLate: (e) => late.push(...e) })
    expect(n(shellCreated('sh_1', 'ses_1'))).toEqual([]) // shell 事件本身不映射
    expect(n(succeeded('ses_1'))).toEqual([]) // ★ 抑制：非 [session.completed]
    expect(late).toEqual([])
  })

  it('最后一个后台 shell exited → 宽限到点 → onLate 补发 session.completed（引擎联动：完成入队）', () => {
    const clock = manualClock()
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ schedule: clock.schedule, onLate: (e) => late.push(...e) })
    const engine = new AggregationEngine()
    const feedAll = (events: InternalEvent[]): void => {
      for (const e of events) engine.apply(e, 1000)
    }

    n(shellCreated('sh_1', 'ses_1'))
    feedAll(n(succeeded('ses_1')))
    n(shellExited('sh_1'))
    clock.fire()

    expect(late).toEqual([{ type: 'session.completed', sessionID: 'ses_1' }])
    feedAll(late) // index.ts 的 onLate 通路：补发事件进引擎
    expect(engine.stats().done.length).toBe(1) // ★ 完成队列最终入账
  })

  it('宽限期内宿主通知唤醒（started 到达）→ 取消补发完成（无涟漪闪烁）', () => {
    const clock = manualClock()
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ schedule: clock.schedule, onLate: (e) => late.push(...e) })
    n(shellCreated('sh_1', 'ses_1'))
    n(succeeded('ses_1'))
    n(shellExited('sh_1'))
    expect(n(started('ses_1'))).toEqual([{ type: 'session.started', sessionID: 'ses_1' }]) // 正常唤醒
    clock.fire()
    expect(late).toEqual([]) // ★ 宽限取消：不补发完成
  })

  it('前台 shell（轮次结束前已 exited）→ succeeded 正常映射 completed，不抑制', () => {
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ onLate: (e) => late.push(...e) })
    n(shellCreated('sh_1', 'ses_1'))
    n(shellExited('sh_1')) // 前台：轮次内跑完退出
    n(shellDeleted('sh_1'))
    expect(n(succeeded('ses_1'))).toEqual([{ type: 'session.completed', sessionID: 'ses_1' }])
    expect(late).toEqual([])
  })

  it('打断（interrupted）撤销抑制 → shell 排空后不补发完成（D13 不庆祝不通知）', () => {
    const clock = manualClock()
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ schedule: clock.schedule, onLate: (e) => late.push(...e) })
    n(shellCreated('sh_1', 'ses_1'))
    n(succeeded('ses_1'))
    expect(n(interrupted('ses_1'))).toEqual([{ type: 'session.abandoned', sessionID: 'ses_1' }])
    n(shellExited('sh_1'))
    clock.fire()
    expect(late).toEqual([]) // ★ 打断后不再补发
  })

  it('多后台 shell：仅一个退出不触发；全部排空才补发', () => {
    const clock = manualClock()
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ schedule: clock.schedule, onLate: (e) => late.push(...e) })
    n(shellCreated('sh_1', 'ses_1'))
    n(shellCreated('sh_2', 'ses_1'))
    n(succeeded('ses_1'))
    n(shellExited('sh_1'))
    clock.fire() // sh_2 还活着：即便 fire 也不该有 pending 计划外触发——此时根本没排计时
    expect(late).toEqual([])
    n(shellExited('sh_2'))
    clock.fire()
    expect(late).toEqual([{ type: 'session.completed', sessionID: 'ses_1' }])
  })

  it('畸形 shell 事件 → 静默忽略不抛；后续 succeeded 不受影响', () => {
    const late: InternalEvent[] = []
    const n = createOpencodeNormalizer({ onLate: (e) => late.push(...e) })
    expect(n(ev('shell.created', null))).toEqual([])
    expect(n(ev('shell.created', {}))).toEqual([])
    expect(n(ev('shell.exited', {}))).toEqual([])
    expect(n(ev('shell.exited', { id: 'sh_unknown' }))).toEqual([]) // 未登记的 shell
    expect(n(succeeded('ses_1'))).toEqual([{ type: 'session.completed', sessionID: 'ses_1' }]) // 正常
    expect(late).toEqual([])
  })

  it('纯函数版行为保持不变（无 shell 场景下工厂与裸函数等价）', () => {
    const n = createOpencodeNormalizer()
    expect(n(ev('permission.asked', { sessionID: 'ses_1' }))).toEqual(
      normalizeOpencodeEvent(ev('permission.asked', { sessionID: 'ses_1' })),
    )
    expect(n(ev('session.tool.called', { sessionID: 'ses_1', id: 'c1', input: { command: 'npm test' } }))).toEqual(
      normalizeOpencodeEvent(ev('session.tool.called', { sessionID: 'ses_1', id: 'c1', input: { command: 'npm test' } })),
    )
  })
})
