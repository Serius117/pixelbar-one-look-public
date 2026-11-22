/**
 * PixelBar HID 协议层 —— 纯函数，零依赖。
 *
 * 唯一权威规格：docs/protocol.md（D39 抓包标定成果）。
 * 帧格式（host → device，64 字节 report）：
 *   [0x2E(reportID), 0xAA, 0xEC, cmd, lenHi, lenLo, ...payload, crc, ...零填充]
 * CRC = 从 0xAA 起（含）到 payload 末尾逐字节求和 mod 256（排除 report ID，见 DECISIONS D03）。
 * 协议层越界 throw；静默降级由设备层（device.ts）负责。
 */

export const VID = 0x2d99
export const PIDS: readonly number[] = [0xa106, 0xa160]
export const CONTROL_INTERFACE = 4
export const VENDOR_USAGE_PAGE = 0xff14
export const REPORT_SIZE = 64
export const MAX_PAYLOAD = 57

export const CMD = {
  MOOD_QUERY: 0x6a,
  MOOD_SET: 0x6b,
  MOOD_RESET: 0x72,
  VOLUME_QUERY: 0x66,
  VOLUME_SET: 0x67,
  TEXT_QUERY: 0xe7,
  TEXT_SET: 0xe8,
  PIXEL_STATE: 0xee,
  PIXEL_SET: 0xef,
} as const

/** 0x6B 灯区 = 效果选择器（厂商 App 语义，protocol.md §0x6B） */
export const LIGHT = {
  BREATHING: 1, // 氛围呼吸（空闲/待报）
  TIDE: 2, // 幻彩潮汐（本插件未使用）
  SOLID: 3, // 纯色静光（失败=红）
  RIPPLE: 4, // 炫彩涟漪（完成庆祝）
  FLOW: 5, // 流光逐影（执行中）
  SHADOW: 6, // 动态光影（等待权限）
  MASTER: 7, // 总开关
} as const

// ---------- CRC 与帧构造 ----------

/** 求和 mod 256；`from` 起始下标（帧构造时传 1 以跳过 report ID） */
export function crc8(bytes: ArrayLike<number>, from = 0): number {
  let sum = 0
  for (let i = from; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff
  return sum
}

/** 构造 64 字节 host 帧；payload > 57 字节 throw */
export function buildFrame(cmd: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`payload ${payload.length}B exceeds ${MAX_PAYLOAD}B limit (protocol.md)`)
  }
  const frame = new Uint8Array(REPORT_SIZE)
  frame[0] = 0x2e // HID output report ID（DECISIONS D03）
  frame[1] = 0xaa
  frame[2] = 0xec
  frame[3] = cmd & 0xff
  frame[4] = (payload.length >> 8) & 0xff
  frame[5] = payload.length & 0xff
  frame.set(payload, 6)
  // CRC 覆盖 0xAA 起到 payload 末尾（不含 report ID、不含 CRC 自身、不含零填充）
  frame[6 + payload.length] = crc8(frame.subarray(1, 6 + payload.length))
  return frame
}

// ---------- 0x6B 灯效 payload ----------

export interface MoodSetOptions {
  /** 设备自报（0x6A 运行时查询，禁写死——协议红线 1） */
  arrayIndex: number
  light: number
  rgb: readonly [number, number, number]
  /** 0-100（厂商 UI 上限），默认 100 */
  brightness?: number
  /** 255 = 保持现值（默认）；呼吸/潮汐厂商用 8 */
  speed?: number
  /** 可选第 8 字节（部分厂商 App payload 含 mode） */
  mode?: number
}

export function moodSetPayload(o: MoodSetOptions): Uint8Array {
  const parts = [
    o.arrayIndex,
    o.light,
    o.rgb[0],
    o.rgb[1],
    o.rgb[2],
    o.brightness ?? 100,
    o.speed ?? 255,
  ]
  if (o.mode !== undefined) parts.push(o.mode)
  return Uint8Array.from(parts)
}

// ---------- 0xE8 文本 payload ----------

/** 设备硬上限：UTF-8 48 字节（PB.34b 实测：54B / 18 个中文被截到 16 字 = 48B） */
export const TEXT_MAX_BYTES = 48
/** 屏宽实测（PB.34b）：256px；中文≈16px、ASCII≈9px（数字实测≈8.8px，取 9 保守） */
export const DISPLAY_WIDTH_PX = 256
export const CJK_WIDTH_PX = 16
export const ASCII_WIDTH_PX = 9

/** 宽字符判定（CJK/假名/谚文/全角/emoji）——宽度预算用，不做字形渲染 */
export function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首..Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  )
}

/** 估算显示宽度（px）——只用于决定静态/滚动，不追求逐字形精确 */
export function textWidthPx(text: string): number {
  let px = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    px += isWideChar(cp) ? CJK_WIDTH_PX : ASCII_WIDTH_PX
  }
  return px
}

/** 推送文本；设备硬上限 48 UTF-8 字节（宽度超限由调度层走 0xEF 滚动，不在此拒绝） */
export function textSetPayload(text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text)
  if (utf8.length > TEXT_MAX_BYTES) {
    throw new Error(`text ${utf8.length}B exceeds ${TEXT_MAX_BYTES}B (protocol.md)`)
  }
  return Uint8Array.from([0x00, utf8.length, ...utf8])
}

// ---------- 0xEF 像素设置 payload（文本配套）----------

export type PixelAlign = 0 | 1 | 2 | 3 // 左 / 中 / 右 / 撑满

/** 静态文本：`01 R G B 00 02 00 align FF` */
export function pixelStaticPayload(
  rgb: readonly [number, number, number],
  align: PixelAlign,
): Uint8Array {
  return Uint8Array.from([0x01, ...rgb, 0x00, 0x02, 0x00, align, 0xff])
}

/** 动态文本（右→左滚动，宽度 >256px 用）：`01 R G B 00 02 01 01 FF` */
export function pixelScrollPayload(rgb: readonly [number, number, number]): Uint8Array {
  return Uint8Array.from([0x01, ...rgb, 0x00, 0x02, 0x01, 0x01, 0xff])
}

/** 时钟（空闲态设备原生恢复，一般不主动发）：`01 R G B 00 01 00 00 FF` */
export function pixelClockPayload(rgb: readonly [number, number, number]): Uint8Array {
  return Uint8Array.from([0x01, ...rgb, 0x00, 0x01, 0x00, 0x00, 0xff])
}

/** 主题色：`03 R G B 00 00 FF FF FF` */
export function pixelThemePayload(rgb: readonly [number, number, number]): Uint8Array {
  return Uint8Array.from([0x03, ...rgb, 0x00, 0x00, 0xff, 0xff, 0xff])
}

// ---------- 设备响应解析（2F BB EC ...）----------

export interface DeviceFrame {
  cmd: number
  payload: Uint8Array
}

/**
 * 解析设备响应帧。宽松校验（响应帧 CRC 规则未标定，暂不校验 CRC）：
 * 前缀 0x2F 0xBB 0xEC；len 可信则按 len 截取，否则取到倒数第 1 字节（假设尾 crc）。
 */
export function parseDeviceFrame(frame: Uint8Array): DeviceFrame | null {
  if (frame.length < 7) return null
  if (frame[0] !== 0x2f || frame[1] !== 0xbb || frame[2] !== 0xec) return null
  const cmd = frame[3]
  const len = (frame[4] << 8) | frame[5]
  const end = len >= 1 && len <= MAX_PAYLOAD ? 6 + len : frame.length - 1
  if (end <= 6 || end > frame.length) return null
  return { cmd, payload: frame.slice(6, end) }
}

export interface MoodGroup {
  index: number
  rgb: [number, number, number]
  brightness: number
  speed: number
}

export interface MoodState {
  arrayIndex: number
  currentIndex: number
  groups: MoodGroup[]
}

/** 解析 0x6A/0x72 应答 payload：`[arrayIndex, currentIndex, <6 字节组>...]`，组内 `[index,R,G,B,亮度,speed]` */
export function parseMoodQueryPayload(payload: Uint8Array): MoodState | null {
  if (payload.length < 2) return null
  const groups: MoodGroup[] = []
  for (let off = 2; off + 6 <= payload.length; off += 6) {
    groups.push({
      index: payload[off],
      rgb: [payload[off + 1], payload[off + 2], payload[off + 3]],
      brightness: payload[off + 4],
      speed: payload[off + 5],
    })
  }
  return { arrayIndex: payload[0], currentIndex: payload[1], groups }
}
