/**
 * OutputScheduler —— Aggregate → HID 帧序列的输出调度器（零宿主依赖）。
 *
 * 规格（灯效映射.md + DECISIONS D08/D09）：
 * - 灯效通道：effectKey 去重，变化才三连发（sendFrameReliable 队列内原子）
 * - 文字通道：10s 窗口节律；仅 waiting（等待决策）60s 周期重复；working 事件驱动窗口、无重复
 * - 窗口内刷新走 1s trailing 节流；pending 由 nextDeadline 暴露给宿主循环
 * - 清屏：窗口结束/text 熄灭时发 0xEF 时钟帧（D16 真机实测：设备**不会**自动恢复默认显示，
 *   停推后旧文字永驻——必须主动清）
 * - fitText（PB.34b）：48B 是设备硬限（超出按字节截断）；256px 是屏宽（超出默认滚动，不按字符截断）
 */
import type { DeviceLogger, HidTransport } from '../hid/types.ts'
import {
  CMD,
  DISPLAY_WIDTH_PX,
  LIGHT,
  TEXT_MAX_BYTES,
  moodSetPayload,
  pixelClockPayload,
  pixelScrollPayload,
  pixelStaticPayload,
  textSetPayload,
  textWidthPx,
} from '../hid/protocol.ts'
import type { PixelBarDevice } from '../hid/device.ts'
import type { Aggregate } from './states.ts'

export const TEXT_WINDOW_MS = 10_000
export const TEXT_REPEAT_MS = 60_000
export const TEXT_THROTTLE_MS = 1_000

/** 文字颜色：跟随呼吸默认色（未标定参数，PB.04 真机可调） */
const TEXT_RGB: [number, number, number] = [0x1c, 0xff, 0xf8]

type Effect = {
  light: number
  rgb: readonly [number, number, number]
  brightness: number
  speed: number
}

// 灯效参数表（详细设计 §4.6；done 待报期与 idle 同参数——D06）
const EFFECTS: Record<string, Effect> = {
  idle: { light: LIGHT.BREATHING, rgb: [0x1c, 0xff, 0xf8], brightness: 100, speed: 8 },
  working: { light: LIGHT.FLOW, rgb: [1, 0, 0], brightness: 100, speed: 255 },
  waiting: { light: LIGHT.SHADOW, rgb: [0, 0, 0], brightness: 100, speed: 255 },
  error: { light: LIGHT.SOLID, rgb: [0xff, 0, 0], brightness: 100, speed: 255 },
  'done-celebrate': { light: LIGHT.RIPPLE, rgb: [0, 0, 0], brightness: 100, speed: 255 },
  'done-rest': { light: LIGHT.BREATHING, rgb: [0x1c, 0xff, 0xf8], brightness: 100, speed: 8 },
}

function effectFor(agg: Aggregate): { key: string; effect: Effect } {
  let name: keyof typeof EFFECTS
  switch (agg.kind) {
    case 'done':
      name = agg.celebrating ? 'done-celebrate' : 'done-rest'
      break
    default:
      name = agg.kind
  }
  const effect = EFFECTS[name]
  return { key: `${effect.light}|${effect.rgb.join(',')}|${effect.brightness}|${effect.speed}`, effect }
}

function textFor(agg: Aggregate): string | null {
  switch (agg.kind) {
    case 'idle':
    case 'working':
      // D13：working 无文字——灯效（流光逐影）表达执行态，文字通道专注通知
      return null
    case 'waiting':
    case 'error':
    case 'done':
      return agg.text
  }
}

const isRepeatable = (kind: Aggregate['kind']): boolean =>
  // D18：只有等待决策（waiting）需要 60s 重复提醒；done/error 只显示一次
  // （完成不需要决策；error 红灯常驻已表达，重复文字是打扰）
  kind === 'waiting'

/**
 * fitText（PB.34b 实测校准）：
 * - 48 UTF-8 字节是设备硬上限（54B / 18 个中文实测被截到 16 字）→ 超出只能按字节安全截断；
 * - 256px 是屏宽（中文≈16px、ASCII≈9px）→ 宽度超出**默认滚动**（0xEF scroll），不再按字符截断；
 * - 16 字符只是全角字符的近似值，已废弃。
 */
export function fitText(text: string): { out: string; scroll: boolean } {
  const enc = new TextEncoder()
  let out = text
  let scroll = false
  if (enc.encode(out).length > TEXT_MAX_BYTES) {
    const acc: string[] = []
    let bytes = 0
    for (const ch of [...out]) {
      const n = enc.encode(ch).length
      if (bytes + n > TEXT_MAX_BYTES) break
      acc.push(ch)
      bytes += n
    }
    out = acc.join('')
    scroll = true // 48B 硬上限：滚动也带不动超出的字节
  }
  if (textWidthPx(out) > DISPLAY_WIDTH_PX) scroll = true // 宽度超限：滚动承载全文
  return { out, scroll }
}

const effectKeyOf = (e: Effect): string =>
  `${e.light}|${e.rgb.join(',')}|${e.brightness}|${e.speed}`

export class OutputScheduler {
  private effectKey: string | null = null
  private windowKind: Aggregate['kind'] | null = null
  private windowOpenedTs = 0
  private lastTextTs = 0
  private lastSentText: string | null = null
  private textShown = false
  private pending: { text: string } | null = null
  private readonly device: () => Promise<PixelBarDevice | null>
  private readonly log: DeviceLogger

  constructor(device: () => Promise<PixelBarDevice | null>, log: DeviceLogger) {
    this.device = device
    this.log = log
  }

  async update(agg: Aggregate, now: number): Promise<void> {
    // ---- 灯效通道（去重 + 三连发）----
    const { key, effect } = effectFor(agg)
    if (key !== this.effectKey) {
      this.effectKey = key
      const dev = await this.device()
      if (dev) {
        // 构造失败（如超限）属代码错误：静默 warn 吞掉，不抛进宿主（铁律 1）
        await dev
          .sendFrameReliable(
            CMD.MOOD_SET,
            moodSetPayload({
              arrayIndex: dev.arrayIndex,
              light: effect.light,
              rgb: effect.rgb,
              brightness: effect.brightness,
              speed: effect.speed,
            }),
          )
          .catch((err: unknown) => this.log.warn('effect send failed', err))
      }
    }

    // ---- 文字通知通道（10s 窗口；仅 waiting 60s 重复，D09/D16/D18）----
    const text = textFor(agg)
    if (text === null) {
      // idle/working：关闭一切文字状态，并主动清屏（真机实测：设备不会自动恢复，D16）
      if (this.textShown) await this.clearText()
      this.windowKind = null
      this.pending = null
      return
    }

    if (this.windowKind !== agg.kind) {
      await this.openWindow(text, now, agg.kind)
      return
    }

    const open = now - this.windowOpenedTs < TEXT_WINDOW_MS
    if (open) {
      if (text !== this.lastSentText) {
        await this.sendText(text, now, false)
      }
    } else {
      // 窗口已关：仅 waiting 60s 周期重开；文本语义变化立即开新窗
      // （waiting 计数变化/error 浮出）——done 轮播条目切换不在此列（周期性，非新信息）
      const repeatDue =
        isRepeatable(agg.kind) && now - this.windowOpenedTs >= TEXT_REPEAT_MS
      const reopenForText =
        text !== this.lastSentText && agg.kind !== 'done'
      if (repeatDue || reopenForText) {
        await this.openWindow(text, now, agg.kind)
      } else if (this.textShown) {
        // 窗口结束且不续发 → 主动回时钟（D16：设备端无 10s 自动恢复，实测）
        await this.clearText()
      }
    }
  }

  private async openWindow(
    text: string,
    now: number,
    kind: Aggregate['kind'],
  ): Promise<void> {
    this.windowKind = kind
    this.windowOpenedTs = now
    await this.sendText(text, now, true)
  }

  private async sendText(text: string, now: number, immediate: boolean): Promise<void> {
    if (!immediate && this.lastTextTs > 0 && now - this.lastTextTs < TEXT_THROTTLE_MS) {
      this.pending = { text } // trailing：宿主循环经 nextDeadline 在 1s 边界重触发
      return
    }
    this.pending = null
    const dev = await this.device()
    if (!dev) return // 无设备：静默跳过（状态照常推进）
    const { out, scroll } = fitText(text)
    try {
      // fitText 保证双限制，此处 try 兜底任何构造错误（同步 throw / rejection 一律静默 warn，铁律 1）
      await dev.sendFrame(CMD.PIXEL_SET, scroll ? pixelScrollPayload(TEXT_RGB) : pixelStaticPayload(TEXT_RGB, 1))
      await dev.sendFrame(CMD.TEXT_SET, textSetPayload(out))
    } catch (err) {
      this.log.warn('text frames send failed', err)
    }
    this.lastTextTs = now
    this.lastSentText = text
    this.textShown = true
  }

  /** 清屏：发 0xEF 时钟帧回设备默认显示（D16；真机实测设备不会自动恢复旧文字） */
  private async clearText(): Promise<void> {
    this.textShown = false
    const dev = await this.device()
    if (!dev) return
    try {
      await dev.sendFrame(CMD.PIXEL_SET, pixelClockPayload(TEXT_RGB))
    } catch (err) {
      this.log.warn('clock restore send failed', err)
    }
  }

  /** 节律层 deadline：窗口到期 / 60s 周期 / trailing 待发点 */
  nextDeadline(now: number): number | null {
    const list: number[] = []
    if (this.windowKind) {
      const open = now - this.windowOpenedTs < TEXT_WINDOW_MS
      list.push(this.windowOpenedTs + (open ? TEXT_WINDOW_MS : TEXT_REPEAT_MS))
    }
    if (this.pending && this.lastTextTs > 0) {
      list.push(this.lastTextTs + TEXT_THROTTLE_MS)
    }
    const next = list.filter((t) => t > now).sort((a, b) => a - b)[0]
    return next ?? null
  }
}

// 避免 TS 未使用导入告警（HidTransport 仅为文档引用）
export type { HidTransport }
