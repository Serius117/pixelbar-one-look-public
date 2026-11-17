/**
 * VirtualPixelBar —— HID 帧流解码器：裸字节 → 人可读语义行（测试断言 / sim 终端显示共用）。
 * 语义记号（测试设计 §3）：MOOD <名>(r,g,b,亮度,速度) / TEXT "<utf8>" / PIXEL static|scroll|clock
 * 相邻同帧 MOOD 合并显示（三连发 ×N 友好化）；0x6A 查询帧输出 MOOD_QUERY（断言时过滤）。
 */
import { CMD } from './protocol.ts'

const LIGHT_NAMES: Record<number, string> = {
  1: 'breathing',
  2: 'tide',
  3: 'solid',
  4: 'ripple',
  5: 'flow',
  6: 'shadow',
  7: 'master',
}

export function decodeFrames(
  writes: readonly Uint8Array[],
  opts?: { suffix?: boolean },
): string[] {
  const lines: string[] = []
  let lastMood: string | null = null
  let moodCount = 0
  const flushMood = (): void => {
    if (lastMood !== null) {
      const suffix = opts?.suffix && moodCount > 1 ? ` x${moodCount}` : ''
      lines.push(`${lastMood}${suffix}`)
    }
    lastMood = null
    moodCount = 0
  }
  for (const frame of writes) {
    if (frame.length < 6 || frame[0] !== 0x2e) continue
    const cmd = frame[3]
    const payload = frame.subarray(6)
    if (cmd === CMD.MOOD_SET) {
      const light = payload[1]
      const name = LIGHT_NAMES[light] ?? `light${light}`
      const line = `MOOD ${name}(${payload[2]},${payload[3]},${payload[4]},${payload[5]},${payload[6]})`
      if (line === lastMood) moodCount++
      else {
        flushMood()
        lastMood = line
        moodCount = 1
      }
    } else if (cmd === CMD.TEXT_SET) {
      flushMood()
      const len = payload[1]
      const text = new TextDecoder().decode(payload.subarray(2, 2 + len))
      lines.push(`TEXT "${text}"`)
    } else if (cmd === CMD.PIXEL_SET) {
      flushMood()
      const mode = payload[5] === 0x01 ? 'clock' : payload[6] === 0x01 ? 'scroll' : 'static'
      lines.push(`PIXEL ${mode}`)
    } else if (cmd === CMD.MOOD_QUERY) {
      flushMood()
      lines.push('MOOD_QUERY')
    }
  }
  flushMood()
  return lines
}
