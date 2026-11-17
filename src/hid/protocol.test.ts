/**
 * 协议层测试 —— 黄金向量交叉验证（CARD.PB.01 DoD）。
 * 黄金样本：docs/protocol.md §0x6B（TempoHub 1.3.1 抓包标定）。
 */
import { describe, expect, it } from 'vitest'
import {
  CMD,
  LIGHT,
  REPORT_SIZE,
  buildFrame,
  crc8,
  moodSetPayload,
  parseDeviceFrame,
  parseMoodQueryPayload,
  pixelClockPayload,
  pixelScrollPayload,
  pixelStaticPayload,
  pixelThemePayload,
  textSetPayload,
} from './protocol.ts'

const A = 0x20 // 黄金样本的 arrayIndex（仅测试用；运行时必须 0x6A 查询——红线 1）

describe('0x6B moodSetPayload — protocol.md 黄金向量逐字节', () => {
  it.each([
    ['breathing 空闲呼吸', LIGHT.BREATHING, [0x1c, 0xff, 0xf8], 100, 8, [0x20, 0x01, 0x1c, 0xff, 0xf8, 0x64, 0x08]],
    ['tide 幻彩潮汐', LIGHT.TIDE, [1, 0, 0], 100, 8, [0x20, 0x02, 0x01, 0x00, 0x00, 0x64, 0x08]],
    ['solid 样本(R=1)', LIGHT.SOLID, [1, 0, 0], 100, 255, [0x20, 0x03, 0x01, 0x00, 0x00, 0x64, 0xff]],
    ['solid 失败红', LIGHT.SOLID, [0xff, 0, 0], 100, 255, [0x20, 0x03, 0xff, 0x00, 0x00, 0x64, 0xff]],
    ['ripple 炫彩涟漪', LIGHT.RIPPLE, [0, 0, 0], 100, 255, [0x20, 0x04, 0x00, 0x00, 0x00, 0x64, 0xff]],
    ['flow 流光逐影', LIGHT.FLOW, [1, 0, 0], 100, 255, [0x20, 0x05, 0x01, 0x00, 0x00, 0x64, 0xff]],
    ['shadow 动态光影', LIGHT.SHADOW, [0, 0, 0], 100, 255, [0x20, 0x06, 0x00, 0x00, 0x00, 0x64, 0xff]],
  ])('%s', (_name, light, rgb, brightness, speed, expected) => {
    const p = moodSetPayload({
      arrayIndex: A,
      light,
      rgb: rgb as [number, number, number],
      brightness,
      speed,
    })
    expect([...p]).toEqual(expected)
  })

  it('mode 可选第 8 字节', () => {
    const p = moodSetPayload({ arrayIndex: A, light: LIGHT.SOLID, rgb: [1, 0, 0], mode: 0x02 })
    expect([...p]).toEqual([0x20, 0x03, 0x01, 0x00, 0x00, 0x64, 0xff, 0x02])
  })

  it('默认 brightness=100(0x64) speed=255(0xFF)', () => {
    const p = moodSetPayload({ arrayIndex: A, light: LIGHT.FLOW, rgb: [1, 0, 0] })
    expect([...p]).toEqual([0x20, 0x05, 0x01, 0x00, 0x00, 0x64, 0xff])
  })
})

describe('crc8 与帧构造交叉验证', () => {
  it('crc8 与测试内独立实现的求和一致（两条独立路径）', () => {
    const frame = buildFrame(
      CMD.MOOD_SET,
      moodSetPayload({ arrayIndex: A, light: LIGHT.FLOW, rgb: [1, 0, 0] }),
    )
    // 独立实现：reduce 求和（区别于 protocol.ts 的 for 循环）
    const independent = [...frame].slice(1, 13).reduce((acc, b) => (acc + b) % 256, 0)
    expect(crc8(frame.subarray(1, 13))).toBe(independent)
    expect(frame[13]).toBe(independent)
  })

  it('breathing 帧手算 CRC 向量 = 0xA8', () => {
    // 手算：AA+EC+6B+00+07 + 20+01+1C+FF+F8+64+08 = 1192 = 4×256+168 → 0xA8
    const frame = buildFrame(
      CMD.MOOD_SET,
      moodSetPayload({ arrayIndex: A, light: LIGHT.BREATHING, rgb: [0x1c, 0xff, 0xf8], brightness: 100, speed: 8 }),
    )
    expect(frame[13]).toBe(0xa8)
  })

  it('帧结构：reportID/同步/工作码/长度BE/CRC位置/零填充', () => {
    const frame = buildFrame(CMD.TEXT_SET, Uint8Array.from([1, 2, 3]))
    expect(frame).toHaveLength(REPORT_SIZE)
    expect(frame[0]).toBe(0x2e) // report ID（D03）
    expect(frame[1]).toBe(0xaa)
    expect(frame[2]).toBe(0xec)
    expect(frame[3]).toBe(0xe8)
    expect(frame[4]).toBe(0x00)
    expect(frame[5]).toBe(0x03)
    expect([...frame.slice(6, 9)]).toEqual([1, 2, 3])
    // 手算：AA(170)+EC(236)+E8(232)+00+03 + 01+02+03 = 647 → 647-512 = 135(0x87)
    expect(frame[9]).toBe(135)
    expect(frame.slice(10).every((b) => b === 0)).toBe(true)
  })

  it('payload > 57 → throw（红线 5 同源）', () => {
    expect(() => buildFrame(CMD.MOOD_SET, new Uint8Array(58))).toThrow(/57/)
  })
})

describe('0xE8 textSetPayload 双限制（16 字符 / 48 UTF-8 字节）', () => {
  it('ASCII 文本', () => {
    expect([...textSetPayload('hello')]).toEqual([0x00, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
  })

  it('空文本', () => {
    expect([...textSetPayload('')]).toEqual([0x00, 0x00])
  })

  it('16 ASCII 恰好通过', () => {
    expect(() => textSetPayload('a'.repeat(16))).not.toThrow()
  })

  it('17 字符 → throw（字符限制）', () => {
    expect(() => textSetPayload('a'.repeat(17))).toThrow(/16/)
  })

  it('16 个中文 = 48 字节恰好通过（双限制边界）', () => {
    const text = '一二三四五六七八九十一二三四五六' // 16 码点 × 3B
    expect([...text].length).toBe(16)
    expect(() => textSetPayload(text)).not.toThrow()
  })

  it('17 个中文 → throw', () => {
    expect(() => textSetPayload('一'.repeat(17))).toThrow()
  })

  it('16 emoji = 64 字节 → 字节限制 throw（字符数合法）', () => {
    expect(() => textSetPayload('😀'.repeat(16))).toThrow(/48/)
  })
})

describe('0xEF 像素设置 payload 字节向量', () => {
  const rgb = [0x10, 0x20, 0x30] as const
  it.each([
    ['static 左对齐', pixelStaticPayload(rgb, 0), [0x01, 0x10, 0x20, 0x30, 0x00, 0x02, 0x00, 0x00, 0xff]],
    ['static 居中', pixelStaticPayload(rgb, 1), [0x01, 0x10, 0x20, 0x30, 0x00, 0x02, 0x00, 0x01, 0xff]],
    ['scroll 滚动', pixelScrollPayload(rgb), [0x01, 0x10, 0x20, 0x30, 0x00, 0x02, 0x01, 0x01, 0xff]],
    ['clock 时钟', pixelClockPayload(rgb), [0x01, 0x10, 0x20, 0x30, 0x00, 0x01, 0x00, 0x00, 0xff]],
    ['theme 主题色', pixelThemePayload(rgb), [0x03, 0x10, 0x20, 0x30, 0x00, 0x00, 0xff, 0xff, 0xff]],
  ])('%s', (_name, actual, expected) => {
    expect([...actual]).toEqual(expected)
  })
})

describe('设备响应解析', () => {
  function makeResponse(cmd: number, payload: number[]): Uint8Array {
    const f = new Uint8Array(REPORT_SIZE)
    f[0] = 0x2f
    f[1] = 0xbb
    f[2] = 0xec
    f[3] = cmd
    f[4] = payload.length >> 8
    f[5] = payload.length & 0xff
    f.set(payload, 6)
    f[6 + payload.length] = 0x99 // 响应 CRC 规则未标定，暂不校验
    return f
  }

  it('parseDeviceFrame 合法响应', () => {
    const r = parseDeviceFrame(makeResponse(0x6a, [0x20, 0x03]))
    expect(r?.cmd).toBe(0x6a)
    expect([...r!.payload]).toEqual([0x20, 0x03])
  })

  it('parseDeviceFrame 拒绝非 0x2F 前缀（host 帧）', () => {
    const hostFrame = buildFrame(CMD.MOOD_SET, new Uint8Array(0))
    expect(parseDeviceFrame(hostFrame)).toBeNull()
  })

  it('parseDeviceFrame 过短帧 → null', () => {
    expect(parseDeviceFrame(new Uint8Array(6))).toBeNull()
  })

  it('parseMoodQueryPayload 单组', () => {
    const st = parseMoodQueryPayload(
      Uint8Array.from([0x20, 0x03, 1, 0x1c, 0xff, 0xf8, 0x64, 0x08]),
    )
    expect(st).toEqual({
      arrayIndex: 0x20,
      currentIndex: 3,
      groups: [{ index: 1, rgb: [0x1c, 0xff, 0xf8], brightness: 0x64, speed: 0x08 }],
    })
  })

  it('parseMoodQueryPayload 多组', () => {
    const st = parseMoodQueryPayload(
      Uint8Array.from([0x20, 0x03, 1, 1, 0, 0, 0x64, 0xff, 2, 2, 0, 0, 0x64, 0xff]),
    )
    expect(st?.groups).toHaveLength(2)
    expect(st?.groups[1]).toEqual({ index: 2, rgb: [2, 0, 0], brightness: 0x64, speed: 0xff })
  })

  it('parseMoodQueryPayload 尾部残组忽略', () => {
    const st = parseMoodQueryPayload(Uint8Array.from([0x20, 0x01, 1, 1, 0, 0, 0x64, 0xff, 9, 9]))
    expect(st?.groups).toHaveLength(1)
  })

  it('parseMoodQueryPayload 不足 2 字节 → null', () => {
    expect(parseMoodQueryPayload(Uint8Array.from([0x20]))).toBeNull()
  })
})
