/**
 * 设备层测试 —— 单写者队列 / 三连发时序 / 静默降级 / fatal / queryMood（CARD.PB.01 DoD）。
 * 全部经 MockTransport，CI 零硬件；node-hid 发现/打开链路留 PB.04 真机验证。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DeviceHolder,
  PixelBarDevice,
  pickPixelBarDevice,
  queryMood,
  rankPixelBarDevices,
} from './device.ts'
import { MockTransport } from './mock-device.ts'
import {
  CMD,
  LIGHT,
  PIDS,
  REPORT_SIZE,
  VENDOR_USAGE_PAGE,
  VID,
  moodSetPayload,
  textSetPayload,
} from './protocol.ts'
import { SILENT_LOGGER, type DeviceLogger } from './types.ts'

const logger: DeviceLogger = SILENT_LOGGER

function moodResponseFrame(arrayIndex = 0x20, currentIndex = 0x03): Uint8Array {
  const payload = [arrayIndex, currentIndex, 1, 0x1c, 0xff, 0xf8, 0x64, 0x08]
  const f = new Uint8Array(REPORT_SIZE)
  f[0] = 0x2f
  f[1] = 0xbb
  f[2] = 0xec
  f[3] = 0x6a
  f[4] = payload.length >> 8
  f[5] = payload.length & 0xff
  f.set(payload, 6)
  return f
}

async function makeDevice(transport: MockTransport): Promise<PixelBarDevice> {
  const dev = await PixelBarDevice.fromTransport(transport, logger)
  expect(dev).not.toBeNull()
  return dev!
}

describe('fromTransport：arrayIndex 运行时查询（红线 1 / D04）', () => {
  it('查询成功 → 设备就绪，arrayIndex 来自应答而非写死', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame(0x37))
    const dev = await PixelBarDevice.fromTransport(transport, logger)
    expect(dev?.arrayIndex).toBe(0x37)
    expect(dev?.closed).toBe(false)
    // 查询帧是写入流的第一帧，cmd=0x6A
    expect(transport.writes[0][3]).toBe(0x6a)
  })

  it('查询 3 连败 → close + null（宁可不用也不猜）', async () => {
    const transport = new MockTransport()
    const dev = await PixelBarDevice.fromTransport(transport, logger)
    expect(dev).toBeNull()
    expect(transport.closed).toBe(true)
    expect(transport.writes).toHaveLength(3) // 3 次重试各发一帧
  })
})

describe('queryMood：写 0x6A 查询帧并解析应答', () => {
  it('正常路径', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const st = await queryMood(transport, logger)
    expect(transport.writes).toHaveLength(1)
    expect(transport.writes[0][3]).toBe(0x6a)
    expect(st?.arrayIndex).toBe(0x20)
    expect(st?.currentIndex).toBe(0x03)
    expect(st?.groups[0]).toEqual({ index: 1, rgb: [0x1c, 0xff, 0xf8], brightness: 0x64, speed: 0x08 })
  })

  it('read 超时 → null', async () => {
    const transport = new MockTransport()
    expect(await queryMood(transport, logger)).toBeNull()
  })

  it('应答 cmd 不是 0x6A → null', async () => {
    const transport = new MockTransport()
    const wrong = moodResponseFrame()
    wrong[3] = 0x6b // cmd 字段改坏
    transport.readQueue.push(wrong)
    expect(await queryMood(transport, logger)).toBeNull()
  })

  it('真机实证：先收到 0x6B 回声帧 → 跳过并继续等到 0x6A', async () => {
    const transport = new MockTransport()
    const echo = moodResponseFrame()
    echo[3] = 0x6b // 0x6B 设置后的回声帧（真机实测存在）
    transport.readQueue.push(echo, moodResponseFrame(0x20))
    const st = await queryMood(transport, logger, 500)
    expect(st?.arrayIndex).toBe(0x20)
    expect(transport.readQueue).toHaveLength(0)
  })
})

describe('pickPixelBarDevice：node-hid v3 真机形状（interface 字段）与候选排序', () => {
  it('真机实测形状：0xFF14（Col02）优先于同 interface 的 Col01（0xFF13 写即失败）', () => {
    const picked = pickPixelBarDevice([
      { vendorId: VID, productId: PIDS[1], path: 'col01', interface: 4, usagePage: 0xff13 },
      { vendorId: VID, productId: PIDS[1], path: 'col02', interface: 4, usagePage: VENDOR_USAGE_PAGE },
    ])
    expect(picked?.path).toBe('col02')
  })

  it('v3 形状只有 interface: 4 → 仍作为候选（未知硬件兜底）', () => {
    const picked = pickPixelBarDevice([
      { vendorId: VID, productId: PIDS[0], path: 'v3-ctrl', interface: 4, usagePage: 0xff13 },
    ])
    expect(picked?.path).toBe('v3-ctrl')
  })

  it('旧形状 interfaceNumber: 4 → 仍兼容', () => {
    const picked = pickPixelBarDevice([
      { vendorId: VID, productId: PIDS[0], path: 'legacy', interfaceNumber: 4 },
    ])
    expect(picked?.path).toBe('legacy')
  })

  it('rank 顺序：0xFF14 → interface 4 → 排除无关接口（interface 3 不带 0xFF14）', () => {
    const ranked = rankPixelBarDevices([
      { vendorId: VID, productId: PIDS[0], path: 'if3', interface: 3, usagePage: 0x0c },
      { vendorId: VID, productId: PIDS[0], path: 'if4', interface: 4, usagePage: 0xff13 },
      { vendorId: VID, productId: PIDS[0], path: 'vendor', interface: 4, usagePage: VENDOR_USAGE_PAGE },
    ])
    expect(ranked.map((d) => d.path)).toEqual(['vendor', 'if4'])
  })

  it('VID/PID 不匹配 → null（宁可不猜）', () => {
    expect(
      pickPixelBarDevice([{ vendorId: 0x1234, productId: PIDS[0], path: 'x', interface: 4 }]),
    ).toBeNull()
    expect(
      pickPixelBarDevice([{ vendorId: VID, productId: 0x1234, path: 'y', interface: 4 }]),
    ).toBeNull()
  })
})

describe('单写者队列（架构铁律 1）', () => {
  it('并发发送严格串行、无交错', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    transport.writeDelays.push(60, 10) // 第一笔慢 60ms、第二笔 10ms：若并发必乱序
    const p1 = dev.sendFrame(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] }))
    const p2 = dev.sendFrame(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.TIDE, rgb: [1, 0, 0] }))
    await Promise.all([p1, p2])
    // 顺序保持调用序，第二笔开始于第一笔结束之后（writes[0] 是查询帧，发送帧从 [1] 起）
    expect(transport.writes[1][7]).toBe(LIGHT.FLOW) // payload[1]=light 在帧偏移 7
    expect(transport.writes[2][7]).toBe(LIGHT.TIDE)
    expect(transport.timeline[2].start).toBeGreaterThanOrEqual(transport.timeline[1].end)
  })

  it('队列不因失败而卡死', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    transport.failNextWrites = 1
    await dev.sendFrame(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] }))
    await dev.sendFrame(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] }))
    expect(transport.writes).toHaveLength(2) // 查询 1 + 成功 1；失败那次不记录
  })
})

describe('三连发（速率纪律：灯效切换抗丢包）', () => {
  it('同帧 ×3、间隔 ≥30ms、队列内原子', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    await dev.sendFrameReliable(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.RIPPLE, rgb: [0, 0, 0] }))
    const writes = transport.writes.slice(-3) // 排除查询帧
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[2]).toEqual(writes[0])
    const [a, b, c] = transport.timeline.slice(-3)
    expect(b.start - a.end).toBeGreaterThanOrEqual(25) // 30ms 目标，留计时容差
    expect(c.start - b.end).toBeGreaterThanOrEqual(25)
  })

  it('三连发中途 fatal 立即停止', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    transport.failNextWrites = 3
    await dev.sendFrameReliable(CMD.MOOD_SET, moodSetPayload({ arrayIndex: 0x20, light: LIGHT.RIPPLE, rgb: [0, 0, 0] }))
    // 第 3 次失败触发 fatal：尝试 3 次即止，无第 4 次
    expect(transport.failNextWrites).toBe(0)
    expect(dev.closed).toBe(true)
  })
})

describe('静默降级（铁律 1：绝不抛进宿主）', () => {
  it('单次写失败不 reject', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    transport.failNextWrites = 1
    await expect(
      dev.sendFrame(CMD.TEXT_SET, textSetPayload('hi')),
    ).resolves.toBeUndefined()
  })

  it('失败后成功写 → 连败计数清零，不误伤后续', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    const onFatal = vi.fn()
    dev.onFatal = onFatal
    transport.failNextWrites = 2
    const frame = moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] })
    await dev.sendFrame(CMD.MOOD_SET, frame) // 失败 1
    await dev.sendFrame(CMD.MOOD_SET, frame) // 失败 2
    await dev.sendFrame(CMD.MOOD_SET, frame) // 成功 → 清零
    transport.failNextWrites = 2
    await dev.sendFrame(CMD.MOOD_SET, frame) // 失败
    await dev.sendFrame(CMD.MOOD_SET, frame) // 失败（计数 2 < 3）
    expect(onFatal).not.toHaveBeenCalled()
    expect(dev.closed).toBe(false)
  })

  it('连续 3 次写失败 → fatal：close + onFatal 一次', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    const onFatal = vi.fn()
    dev.onFatal = onFatal
    transport.failNextWrites = 3
    const frame = moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] })
    await dev.sendFrame(CMD.MOOD_SET, frame)
    await dev.sendFrame(CMD.MOOD_SET, frame)
    await dev.sendFrame(CMD.MOOD_SET, frame)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(transport.closed).toBe(true)
  })

  it('构造错误（超限 payload）显式 reject 而非静默', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    await expect(dev.sendFrame(CMD.MOOD_SET, new Uint8Array(58))).rejects.toThrow(/57/)
  })
})

describe('DeviceHolder：lazy 重开 + 60s 节流', () => {
  it('open 失败 → 静默 null，节流期内不重试', async () => {
    const openFn = vi.fn(async () => null)
    const holder = new DeviceHolder(openFn, logger)
    expect(await holder.get()).toBeNull()
    expect(await holder.get()).toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1)
  })

  it('持有可用设备；fatal 后清引用，节流期内不再 open', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    const openFn = vi.fn(async () => dev)
    const holder = new DeviceHolder(openFn, logger)
    expect(await holder.get()).toBe(dev)
    expect(await holder.get()).toBe(dev) // 复用，不重复 open
    expect(openFn).toHaveBeenCalledTimes(1)
    // 制造 fatal
    transport.failNextWrites = 3
    const frame = moodSetPayload({ arrayIndex: 0x20, light: LIGHT.FLOW, rgb: [1, 0, 0] })
    await dev.sendFrame(CMD.MOOD_SET, frame)
    await dev.sendFrame(CMD.MOOD_SET, frame)
    await dev.sendFrame(CMD.MOOD_SET, frame)
    // 引用已清：60s 节流内 get 返回 null，且不重试 open
    expect(await holder.get()).toBeNull()
    expect(openFn).toHaveBeenCalledTimes(1)
  })

  it('stop 幂等清理', async () => {
    const transport = new MockTransport()
    transport.readQueue.push(moodResponseFrame())
    const dev = await makeDevice(transport)
    const holder = new DeviceHolder(async () => dev, logger)
    await holder.get()
    holder.stop()
    holder.stop()
    expect(transport.closed).toBe(true)
    expect(await holder.get()).toBeNull()
  })
})
