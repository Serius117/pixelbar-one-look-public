/**
 * dsh 插件入口测试 —— TC-DB 系列（测试设计.md §7.2，v0.2/PB.22）。
 * 全 mock：鸭子类型 ctx + MockTransport 注入（startPixelbar 的 EntryHooks 测试缝，
 * 同 PixelBarDevice.fromTransport 的可测性注入点角色，测试设计 §2）。
 * TC-DB1/TC-DB3 走真机时序（systemClock + 真实 30ms 三连发间隔，每用例 <2s）。
 */
import { describe, expect, it } from 'vitest'
import { PixelBarDevice } from './hid/device.ts'
import { MockTransport } from './hid/mock-device.ts'
import { SILENT_LOGGER } from './hid/types.ts'
import { moodResponseFrame } from './test-runner.ts'
import { DSH_CHANNELS } from './events/dsh'
import { apply, name, startPixelbar } from './dsh-entry'

const S = { id: 'ses_1' }
const A = { agent: { session: S } }

interface MockDsh {
  listeners: Map<string, (...args: unknown[]) => unknown>
  calls: string[]
  effectInits: Array<() => unknown>
  logs: string[]
  on: (name: string, cb: (...args: unknown[]) => unknown) => () => void
  effect: (init: () => unknown) => () => void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

function mockDshCtx(): MockDsh {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const calls: string[] = []
  const effectInits: Array<() => unknown> = []
  const logs: string[] = []
  return {
    listeners,
    calls,
    effectInits,
    logs,
    on: (name, cb) => {
      listeners.set(name, cb)
      calls.push(name)
      return () => {
        listeners.delete(name)
      }
    },
    effect: (init) => {
      effectInits.push(init)
      return () => undefined
    },
    log: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

/** monitor.start 是 fire-and-forget 绑定——轮询直到 server 应答（同 monitor.test 的就绪语义） */
async function waitServer(url: string, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    try {
      await fetch(url)
      return
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error(`server not up: ${url}`)
      await sleep(20)
    }
  }
}

/** 注入 MockTransport 的设备工厂（真机打开链路完整：mood 0x6A 查询 → readQueue 应答） */
function mockOpenDevice(): { transport: MockTransport; openDevice: () => Promise<PixelBarDevice> } {
  const transport = new MockTransport()
  transport.readQueue.push(moodResponseFrame())
  return { transport, openDevice: () => PixelBarDevice.fromTransport(transport, SILENT_LOGGER) }
}

describe('TC-DB1 全链起转：apply → 装配五件套 → idle 呼吸 → working 灯效帧', () => {
  it('MockTransport 收到初始呼吸帧；agent/session-start 后收到 working 灯效帧', async () => {
    const ctx = mockDshCtx()
    const { transport, openDevice } = mockOpenDevice()
    startPixelbar(ctx, { monitor: false }, { openDevice })

    await waitFor(() => transport.writes.length >= 1) // 初始 idle 呼吸上电
    const idleCount = transport.writes.length

    ctx.listeners.get('agent/session-start')!({ ...A })
    await waitFor(() => transport.writes.length > idleCount) // working 流光帧
    expect(ctx.calls.length).toBe(DSH_CHANNELS.length)
    expect(ctx.effectInits.length).toBe(1)

    // 清场（防止泵/设备定时器跨用例泄漏）
    const disposer = ctx.effectInits[0]!() as () => void
    disposer()
  })
})

describe('TC-DB2 铁律 1：宿主接口异常 → 静默降级，绝不抛进宿主', () => {
  it('ctx.on 每通道注册即抛 → apply 不抛 + diag 留痕（面板可查）+ 零订阅', async () => {
    const ctx = mockDshCtx()
    ctx.on = () => {
      throw new Error('host quirk')
    }
    expect(() => startPixelbar(ctx, { monitor: true, monitorPort: 18795 })).not.toThrow()
    expect(ctx.calls.length).toBe(0) // 全部注册失败被逐通道吞掉

    // diag 留痕：monitor 面板 /state（端口 18795，避开 18789-18793 既有用例）
    await waitServer('http://127.0.0.1:18795/state')
    const res = await fetch('http://127.0.0.1:18795/state')
    const state = (await res.json()) as { log: Array<{ kind: string; line: string }> }
    const lines = state.log.map((l) => l.line)
    expect(lines.some((l) => l.includes('dsh apply entered'))).toBe(true)
    expect(lines.some((l) => l.includes('on: yes'))).toBe(true)

    const disposer = ctx.effectInits[0]!() as () => void
    disposer()
  })
})

describe('TC-DB3 生命周期：ctx.effect disposer → 退订 + 停泵 + 关设备，后续事件零帧', () => {
  it('disposer 调用后：通道注销、再触发事件不产生新帧', async () => {
    const ctx = mockDshCtx()
    const { transport, openDevice } = mockOpenDevice()
    startPixelbar(ctx, { monitor: false }, { openDevice })
    await waitFor(() => transport.writes.length >= 1)
    const cb = ctx.listeners.get('agent/session-start')! // 卸载前抓住 listener 引用
    const disposer = ctx.effectInits[0]!() as () => void
    disposer()

    expect(ctx.listeners.size).toBe(0) // 宿主侧 disposer 全部执行
    const n = transport.writes.length
    cb({ ...A }) // 标志位兜底：宿主若未真正注销（无 disposer 场景），也不得再派发
    await sleep(250)
    expect(transport.writes.length).toBe(n) // 零新帧
  })
})

describe('TC-DB4 enabled:false 空转', () => {
  it('scoped 配置块形态：零订阅、零托管、零上电', () => {
    const ctx = mockDshCtx()
    startPixelbar(ctx, { 'pixelbar-one-look': { enabled: false } })
    expect(ctx.calls).toEqual([])
    expect(ctx.effectInits).toEqual([])
  })

  it('扁平 config 形态（📌 PB.23 标定后收敛为一种）：同样空转', () => {
    const ctx = mockDshCtx()
    startPixelbar(ctx, { enabled: false })
    expect(ctx.calls).toEqual([])
    expect(ctx.effectInits).toEqual([])
  })
})

describe('TC-DB5 模块导出形状（Cordis 插件契约）', () => {
  it('export const name 字符串 + export function apply + 零 cordis import（lint 即证）', () => {
    expect(name).toBe('pixelbar-one-look')
    expect(typeof apply).toBe('function')
    expect(typeof startPixelbar).toBe('function')
  })
})

describe('TC-DB7 dsh-entry 无 default 导出（Cordis unwrapExports 陷阱，装载器源码实证）', () => {
  it('src/dsh-entry.ts 命名导出 apply/name 且无 default——装载器 unwrapExports 优先拆 default，存在则被误当插件体（无 apply → 静默装载失败）', async () => {
    const mod = await import('./dsh-entry.ts')
    expect(mod.default).toBeUndefined()
    expect(mod.name).toBe('pixelbar-one-look')
    expect(typeof mod.apply).toBe('function')
  })
})

describe('TC-DB8 宿主面隔离护栏（D02/D21 架构守护——用户审计请求 2026-11-17 落地）', () => {
  it('两宿主面零交叉 import：index.ts 不引 dsh 面，dsh-entry.ts 不引 opencode 面', async () => {
    const { readFileSync } = await import('node:fs')
    const indexSrc = readFileSync('src/index.ts', 'utf8')
    const dshEntrySrc = readFileSync('src/dsh-entry.ts', 'utf8')

    // opencode 面的模块图不得包含 dsh 面（反之 dsh 适配错误永不影响 opencode 路径）
    expect(indexSrc).not.toMatch(/from ['"]\.{0,2}\/?(.*dsh-entry|events\/dsh)/)
    // dsh 面的模块图不得包含 opencode 面
    expect(dshEntrySrc).not.toMatch(/from ['"]\.{0,2}\/?(.*\/index|events\/opencode)/)
  })

  it('清单契约冻结：opencode 主路径（main + exports["."]）永远指向 src/index.ts；dsh 专属字段独立', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    // opencode 契约：主入口形态冻结（宿主插件加载依赖此路径——dsh 侧变更不得触碰）
    expect(pkg.main).toBe('src/index.ts')
    expect(pkg.exports['.']).toBe('./src/index.ts')
    // dsh 契约：子路径 + bundle 声明独立存在
    expect(pkg.exports['./dsh']).toBe('./src/dsh-entry.ts')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(existsSync('cordis.patch.yml')).toBe(true)
  })
})

describe('TC-DB6 logEvents 标定通道（PB.23）', () => {
  it('logEvents: true → monitor /state 出现 raw 诊断行（无项目锚点也有 payload 形态）', async () => {
    const ctx = mockDshCtx()
    const { openDevice } = mockOpenDevice()
    startPixelbar(ctx, { monitor: true, monitorPort: 18796, logEvents: true }, { openDevice })
    ctx.listeners.get('agent/session-start')!({ agent: { session: { id: 'ses_cal' } } })

    await waitServer('http://127.0.0.1:18796/state')
    const res = await fetch('http://127.0.0.1:18796/state')
    const state = (await res.json()) as { log: Array<{ kind: string; line: string }> }
    const lines = state.log.map((l) => l.line)
    expect(lines.some((l) => l.startsWith('raw agent/session-start :: '))).toBe(true)
    expect(lines.some((l) => l.includes('"id":"ses_cal"'))).toBe(true)

    const disposer = ctx.effectInits[0]!() as () => void
    disposer()
  })
})
