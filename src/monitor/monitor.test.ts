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
  it('noteEvent/noteRaw 入日志并裁剪到 200 条', () => {
    const hub = new MonitorHub()
    for (let i = 0; i < 250; i++) {
      hub.noteEvent({ type: 'tool.started', sessionID: 's', text: `t${i}` })
    }
    hub.noteRaw({ type: 'session.idle', location: { directory: 'D:\\proj' } })
    const log = (hub.snapshot() as unknown as { log: Array<{ kind: string; line: string }> }).log
    expect(log.length).toBeLessThanOrEqual(200)
    const raw = log.filter((l) => l.kind === 'raw')
    expect(raw[raw.length - 1].line).toContain('session.idle')
    expect(raw[raw.length - 1].line).toContain('proj')
  })
})
