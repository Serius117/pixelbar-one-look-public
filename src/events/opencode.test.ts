/**
 * 归一化适配器测试 —— v2 实测定稿形态（@opencode/client 2.3.0 types.d.ts）+ v1 草案兼容。
 * 事件顶层 {type, data}（data 携带 sessionID 等载荷）。
 */
import { describe, expect, it } from 'vitest'
import { basename, normalizeOpencodeEvent } from './opencode'

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
