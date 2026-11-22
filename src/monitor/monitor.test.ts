/**
 * MonitorHub 单测 —— 分发代理（真机+镜像）、帧解码、事件日志裁剪、端口独占静默。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PixelBarDevice } from '../hid/device.ts'
import { MockTransport } from '../hid/mock-device.ts'
import { SILENT_LOGGER } from '../hid/types.ts'
import { CMD, LIGHT, moodSetPayload, textSetPayload } from '../hid/protocol.ts'
import { MonitorHub } from './monitor.ts'

async function makeRealDevice(): Promise<{ dev: PixelBarDevice; transport: MockTransport }> {
  const transport = new MockTransport()
  const payload = [0x20, 0x03, 1, 0x1c, 0xff, 0xf8, 0x64, 0x08]
  const f = new Uint8Array(64)
  f[0] = 0x2f
  f[1] = 0xbb
  f[2] = 0xec
  f[3] = 0x6a
  f[5] = payload.length
  f.set(payload, 6)
  transport.readQueue.push(f)
  const dev = await PixelBarDevice.fromTransport(transport, SILENT_LOGGER)
  return { dev: dev!, transport }
}

const started: MonitorHub[] = []
afterEach(() => {
  for (const m of started.splice(0)) m.stop()
})

describe('TeeDevice 分发代理', () => {
  it('真机存在：帧同时进真机与 monitor 记录', async () => {
    const { dev, transport } = await makeRealDevice()
    const hub = new MonitorHub()
    const tee = hub.teeDevice(dev)
    const writesBefore = transport.writes.length
    await tee.sendFrame(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] }))
    expect(transport.writes.length).toBe(writesBefore + 1)
    const snap = hub.snapshot()
    expect(snap.effect?.name).toBe('流光逐影')
    expect(snap.effect?.rgb).toEqual([1, 0, 0])
  })

  it('无真机：帧仅进 monitor，不 throw', async () => {
    const hub = new MonitorHub()
    const tee = hub.teeDevice(null)
    expect(tee.arrayIndex).toBe(0x20) // 缺省 arrayIndex 供 payload 构造
    await tee.sendFrame(CMD.TEXT_SET, textSetPayload('待批准'))
    const snap = hub.snapshot()
    expect(snap.text?.display).toBe('待批准')
    expect(snap.text?.fresh).toBe(true)
  })

  it('窗口过期判定：>10s 后 fresh=false', async () => {
    const hub = new MonitorHub()
    const tee = hub.teeDevice(null)
    await tee.sendFrame(CMD.TEXT_SET, textSetPayload('完成'))
    const before = hub.snapshot().text?.fresh
    // 直接改快照口径：注入一条"很久以前"的记录
    const anyHub = hub as unknown as { lastText: { t: number } | null }
    anyHub.lastText!.t = Date.now() - 20_000
    const after = hub.snapshot().text?.fresh
    expect(before).toBe(true)
    expect(after).toBe(false)
  })
})

describe('HTTP 面板', () => {
  it('新旧实例接管：旧实例自灭并回调清理，新实例绑定成功', async () => {
    const a = new MonitorHub()
    started.push(a)
    let aCleaned = 0
    a.onShutdown = () => {
      aCleaned++
    }
    expect(await a.start(18790)).toBe(true)
    for (let i = 0; i < 20 && !a.isListening(); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(a.isListening()).toBe(true)

    const b = new MonitorHub()
    started.push(b)
    expect(await b.start(18790)).toBe(true) // 同端口：接管而非 EADDRINUSE
    for (let i = 0; i < 20 && !b.isListening(); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(b.isListening()).toBe(true)
    expect(a.isListening()).toBe(false) // 旧实例已让出
    expect(aCleaned).toBe(1) // 旧实例清理回调恰好一次
    const res = await fetch('http://127.0.0.1:18790/state') // 新实例健康
    expect(res.status).toBe(200)
  })

  it('stop 后可重启；GET / 返回面板页', async () => {
    const a = new MonitorHub()
    started.push(a)
    expect(await a.start(18793)).toBe(true)
    a.stop()
    expect(a.isListening()).toBe(false)
    expect(await a.start(18793)).toBe(true)
    const page = await fetch('http://127.0.0.1:18793/')
    expect(await page.text()).toContain('虚拟 PixelBar')
    a.stop()
  })

  it('GET /state 返回 JSON 快照', async () => {
    const hub = new MonitorHub()
    started.push(hub)
    expect(await hub.start(18791)).toBe(true)
    const res = await fetch('http://127.0.0.1:18791/state')
    expect(res.status).toBe(200)
    const snap = (await res.json()) as { log: unknown[]; monitorUrl: string }
    expect(Array.isArray(snap.log)).toBe(true)
    expect(snap.monitorUrl).toContain('127.0.0.1')
  })
})

describe('事件日志', () => {
  it('noteEvent/noteRaw 入日志并裁剪到 5000 条（2026-11-18 扩容：200→5000）', () => {
    const hub = new MonitorHub()
    for (let i = 0; i < 5000 + 50; i++) {
      hub.noteEvent({ type: 'tool.started', sessionID: 's', text: `t${i}` })
    }
    hub.noteRaw({ type: 'session.idle', location: { directory: 'D:\\proj' } })
    const log = (hub.snapshot(5000) as unknown as { log: Array<{ kind: string; line: string }> }).log
    expect(log.length).toBe(5000)
    const raw = log.filter((l) => l.kind === 'raw')
    expect(raw[raw.length - 1].line).toContain('session.idle')
    expect(raw[raw.length - 1].line).toContain('proj')
  })

  it('.delta 增量流限流：每类每秒仅 1 条（防 reasoning/text 流冲掉有意义事件）', () => {
    const hub = new MonitorHub()
    for (let i = 0; i < 100; i++) {
      hub.noteRaw({ type: 'session.reasoning.delta', location: { directory: 'D:\\proj' } })
      hub.noteRaw({ type: 'session.text.delta', location: { directory: 'D:\\proj' } })
    }
    const log = (hub.snapshot() as unknown as { log: Array<{ kind: string; line: string }> }).log
    const deltas = log.filter((l) => l.line.includes('.delta'))
    // 100 轮同毫秒：每类只留首条
    expect(deltas.length).toBe(2)
    expect(deltas.filter((l) => l.line.includes('reasoning.delta')).length).toBe(1)
    expect(deltas.filter((l) => l.line.includes('text.delta')).length).toBe(1)
  })

  it('/state?log=N 深度排障口：默认 60，可取到 5000', async () => {
    const hub = new MonitorHub()
    started.push(hub)
    expect(await hub.start(18798)).toBe(true)
    for (let i = 0; i < 80; i++) {
      hub.noteEvent({ type: 'tool.started', sessionID: 's', text: `t${i}` })
    }
    const def = (await (await fetch('http://127.0.0.1:18798/state')).json()) as { log: unknown[] }
    expect(def.log.length).toBe(60)
    const deep = (await (await fetch('http://127.0.0.1:18798/state?log=80')).json()) as { log: unknown[] }
    expect(deep.log.length).toBe(80)
    const over = (await (await fetch('http://127.0.0.1:18798/state?log=99999')).json()) as { log: unknown[] }
    expect(over.log.length).toBeLessThanOrEqual(80) // 上限钳制到缓冲实有量
  })

  it('持久化 JSONL：事件落盘 monitor-<日期>.jsonl，delta 不落盘，可配置关闭', async () => {
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'pb-test-'))
    try {
      const hub = new MonitorHub(true, dir)
      hub.noteEvent({ type: 'tool.started', sessionID: 's', text: '落盘验证' })
      hub.noteRaw({ type: 'session.reasoning.delta', location: { directory: 'D:\\proj' } })
      hub.noteRaw({ type: 'form.created', data: { form: { id: 'f1' } } })
      // 文件写入是同步 appendFileSync：立即可读
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      expect(files.length).toBe(1)
      const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; line: string })
      expect(lines.some((l) => l.kind === 'event' && l.line.includes('落盘验证'))).toBe(true)
      expect(lines.some((l) => l.kind === 'raw' && l.line.includes('form.created'))).toBe(true)
      expect(lines.some((l) => l.line.includes('.delta'))).toBe(false) // 增量流不落盘
      // 关闭开关：不写
      const off = new MonitorHub(false, dir)
      off.noteEvent({ type: 'tool.started', sessionID: 's', text: '不应落盘' })
      const content = readFileSync(join(dir, files[0]!), 'utf8')
      expect(content.includes('不应落盘')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
