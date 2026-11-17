/**
 * scripts/device-smoke.ts —— 真机 HID 直连冒烟（真机手册第 0 关，不经 opencode）。
 *
 * 目的：在"插件 + 宿主"之前先验证最底层——node-hid 形状 / 设备发现 / 0x6A arrayIndex
 * 查询 / 0x6B 灯效 / 0xE8+0xEF 文字——把排查面缩到最小。
 *
 * 用法：
 *   npm run smoke                          # = --stage all（probe→open→moods→text，约 25s）
 *   npm run smoke -- --stage probe         # 只枚举设备（不开设备）
 *   npm run smoke -- --stage open          # 打开 + queryMood 原值
 *   npm run smoke -- --stage moods --hold 2500
 *   npm run smoke -- --stage text
 *   npm run smoke -- --stage restore      # 0xEF 时钟帧：把设备显示恢复到默认（清掉残留文字）
 *   npm run smoke -- --stage scroll        # D11 实验：>16 字符绕过护栏直发（观察滚动/截断/拒绝）
 *   npm run smoke -- --no-restore          # 结束不恢复空闲呼吸
 *   npm run smoke -- --json                # 追加机器可读摘要
 *
 * 退出码：0 全部检查通过；1 有失败；2 参数错误。
 * 纪律：无人值守、有限时长、结构化输出（AGENTS.md §0）；写失败经 logger 捕获后计入失败项。
 */
import {
  PixelBarDevice,
  loadNodeHid,
  pickPixelBarDevice,
  rankPixelBarDevices,
} from '../src/hid/device.ts'
import {
  CMD,
  CONTROL_INTERFACE,
  LIGHT,
  PIDS,
  VENDOR_USAGE_PAGE,
  VID,
  moodSetPayload,
  pixelClockPayload,
  pixelScrollPayload,
  pixelStaticPayload,
  textSetPayload,
} from '../src/hid/protocol.ts'
import type { DeviceLogger } from '../src/hid/types.ts'

interface ProbeDevice {
  vendorId: number
  productId: number
  path: string
  /** node-hid v3 真实字段；旧形状为 interfaceNumber */
  interface?: number
  interfaceNumber?: number
  usagePage?: number
  usage?: number
  product?: string
  manufacturer?: string
}

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const STAGES = ['probe', 'open', 'moods', 'text', 'scroll', 'restore', 'all'] as const
type Stage = (typeof STAGES)[number]

const TEXT_RGB: [number, number, number] = [0x1c, 0xff, 0xf8]

const MOOD_CYCLE: ReadonlyArray<{
  name: string
  light: number
  rgb: [number, number, number]
  speed: number
}> = [
  { name: 'breathing 呼吸（空闲）', light: LIGHT.BREATHING, rgb: [0x1c, 0xff, 0xf8], speed: 8 },
  { name: 'flow 流光逐影（执行）', light: LIGHT.FLOW, rgb: [1, 0, 0], speed: 255 },
  { name: 'shadow 动态光影（待批准）', light: LIGHT.SHADOW, rgb: [0, 0, 0], speed: 255 },
  { name: 'solid 纯色红（出错）', light: LIGHT.SOLID, rgb: [0xff, 0, 0], speed: 255 },
  { name: 'ripple 炫彩涟漪（完成）', light: LIGHT.RIPPLE, rgb: [0, 0, 0], speed: 255 },
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 刻意绕过 textSetPayload 的 16 字符护栏：D11 真机实验专用（观察设备对超长文本的行为） */
function rawTextPayload(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > 55) throw new Error(`raw text ${bytes.length}B exceeds 55B experiment limit`)
  return Uint8Array.from([0x00, bytes.length, ...bytes])
}

function header(title: string): void {
  console.log('')
  console.log('─'.repeat(64))
  console.log(title)
  console.log('─'.repeat(64))
}

async function main(
  stage: Stage,
  holdMs: number,
  textWaitMs: number,
  noRestore: boolean,
  jsonOut: boolean,
): Promise<number> {
  const startedAt = Date.now()
  const warnings: string[] = []
  const checks: Check[] = []
  const visual: string[] = []

  const logger: DeviceLogger = {
    warn(msg, err) {
      const line = err ? `${msg} — ${String(err)}` : msg
      warnings.push(line)
      console.log(`  [warn] ${line}`)
    },
    debug(msg) {
      console.log(`  [debug] ${msg}`)
    },
  }

  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  let device: PixelBarDevice | null = null
  let textSent = false

  console.log(`pixelbar-one-look device smoke — stage=${stage} hold=${holdMs}ms`)

  // ---------- probe：发现链路 ----------
  if (stage === 'all' || stage === 'probe') {
    header('① probe — node-hid 加载 + 设备枚举')
    const mod = await loadNodeHid(logger)
    if (!mod) {
      check('node-hid 加载（v3 形状：顶层 devices() + HID 构造器）', false, '见上方 warn')
    } else {
      check('node-hid 加载（v3 形状：顶层 devices() + HID 构造器）', true)
      const all = mod.devices() as unknown as ProbeDevice[]
      const matches = all.filter((d) => d.vendorId === VID && PIDS.includes(d.productId))
      console.log(`  全部 HID 设备 ${all.length} 个；PixelBar 匹配 ${matches.length} 个（VID=0x${VID.toString(16)}）`)
      for (const d of matches) {
        console.log(
          `    if=${d.interface ?? d.interfaceNumber ?? '-'}  usagePage=0x${(d.usagePage ?? 0).toString(16)}` +
            `  usage=${d.usage ?? '-'}  ${d.manufacturer ?? ''} ${d.product ?? ''}`,
        )
      }
      check('设备存在（VID/PID 匹配）', matches.length > 0, matches.length === 0 ? '检查 USB 连接/线缆' : undefined)
      const ranked = rankPixelBarDevices(all)
      const desc = (d: ProbeDevice): string =>
        `if=${d.interface ?? d.interfaceNumber ?? '-'} usagePage=0x${(d.usagePage ?? 0).toString(16)}`
      console.log(`  候选顺序：${ranked.length === 0 ? '无' : ranked.map((d) => desc(d as ProbeDevice)).join(' → ')}`)
      const picked = pickPixelBarDevice(all)
      check(
        `过滤选中（优先 usagePage 0x${VENDOR_USAGE_PAGE.toString(16)}，其次 interface ${CONTROL_INTERFACE}）`,
        picked !== null,
        picked ? desc(picked as ProbeDevice) : '放宽 pickPixelBarDevice 过滤（真机手册 §1 失败分支）',
      )
    }
  }

  // ---------- open：打开 + 0x6A arrayIndex（除 probe 外的所有阶段都需要设备） ----------
  if (stage !== 'probe') {
    header('② open — 打开设备 + 0x6A arrayIndex 查询（D04 不猜值）')
    device = await PixelBarDevice.open(logger)
    if (!device) {
      check('打开设备 + queryMood×3', false, '独占冲突（TempoHub 占用？）/ 0x6A payload 需抓包（真机手册 §2.2）')
    } else {
      check('打开设备 + queryMood×3', true, `arrayIndex=${device.arrayIndex}`)
      const mood = await device.queryMood()
      if (mood) {
        console.log('  0x6A 应答（原值，回填真机手册 §2.2）：')
        console.log(`    ${JSON.stringify(mood)}`)
        check('0x6A 应答可解析（arrayIndex/currentIndex/groups）', true)
      } else {
        check('0x6A 应答可解析（arrayIndex/currentIndex/groups）', false, '打开时成功、复核失败：记录为抖动')
      }
    }
  }

  // ---------- moods：五灯效三连发 ----------
  if ((stage === 'all' || stage === 'moods') && device) {
    header(`③ moods — 五种灯效三连发（每种保持 ${holdMs}ms，请目视）`)
    for (let i = 0; i < MOOD_CYCLE.length; i++) {
      const m = MOOD_CYCLE[i]
      console.log(`  ${i + 1}/${MOOD_CYCLE.length} ${m.name}`)
      await device.sendFrameReliable(
        CMD.MOOD_SET,
        moodSetPayload({
          arrayIndex: device.arrayIndex,
          light: m.light,
          rgb: m.rgb,
          brightness: 100,
          speed: m.speed,
        }),
      )
      await sleep(holdMs)
    }
    check('五种灯效帧已三连发（每帧 ×3 / 30ms 间隔）', !device.closed)
    visual.push('5 种灯效都实际变化：呼吸 / 流光 / 光影 / 纯红 / 涟漪')
    const after = await device.queryMood()
    console.log(`  灯效后 0x6A 复核：${after ? JSON.stringify(after) : 'null（无应答）'}`)
  }

  // ---------- text：0xE8 文字 + 自愈观察 ----------
  if ((stage === 'all' || stage === 'text') && device) {
    header('④ text — 0xEF 静态 + 0xE8 文字（观察停推后是否自动恢复）')
    const text = 'PB冒烟 完成'
    await device.sendFrame(CMD.PIXEL_SET, pixelStaticPayload(TEXT_RGB, 1))
    await device.sendFrame(CMD.TEXT_SET, textSetPayload(text))
    textSent = true
    console.log(`  已发 TEXT "${text}"（静态居中，${new TextEncoder().encode(text).length}B）`)
    const firstHold = Math.min(5_000, textWaitMs)
    await sleep(firstHold)
    console.log(`  [t+${(firstHold / 1000).toFixed(0)}s] 此刻应显示文字`)
    await sleep(Math.max(0, textWaitMs - firstHold))
    console.log(
      `  [t+${(textWaitMs / 1000).toFixed(0)}s] 停推观察结束——屏幕若仍显示文字，则"10s 自动恢复"假设不成立（真机手册 §2.4）`,
    )
    check('0xE8 文字帧已发送（显示/自愈需目视）', !device.closed)
    visual.push(
      noRestore
        ? '停推后屏幕是否自动回时钟（D16 实测：不会）'
        : '文字显示后由复位阶段发时钟帧清屏（D16）：屏幕应回到时钟',
    )
  }

  // ---------- restore：0xEF 时钟帧恢复默认显示 ----------
  if (stage === 'restore' && device) {
    header('restore — 发 0xEF 时钟帧，恢复设备默认显示')
    await device.sendFrame(CMD.PIXEL_SET, pixelClockPayload(TEXT_RGB))
    await sleep(800)
    check('时钟恢复帧已发送（屏幕应回时钟/默认显示）', !device.closed)
    visual.push('屏幕是否已回到时钟（若仍显示旧文字 → 时钟帧不是恢复手段，继续实验）')
  }

  // ---------- scroll：D11 超长文本实验（用户命令触发：npm run smoke:scroll） ----------
  if (stage === 'scroll' && device) {
    header('⑤ scroll — 0xEF 长文本实验（D11：设备对 >16 字符文本的真实行为）')
    const longText = 'pixelbar-one-look 长文本滚动实验'
    console.log(`  发送 ${[...longText].length} 字符 / ${new TextEncoder().encode(longText).length}B（刻意绕过 16 字符护栏）`)
    await device.sendFrame(CMD.PIXEL_SET, pixelScrollPayload(TEXT_RGB))
    await device.sendFrame(CMD.TEXT_SET, rawTextPayload(longText))
    textSent = true
    console.log(`  请观察屏幕 ${(textWaitMs / 1000).toFixed(0)} 秒：逐段滚动 / 只显示前 16 字 / 无反应？`)
    await sleep(textWaitMs)
    check('0xEF 滚动实验帧已发送（结果需目视）', !device.closed)
    visual.push('长文本行为三选一：逐段滚动=支持 / 只显示前 16 字=截断 / 无反应=拒绝（记入 D11 → v0.2 卡）')
  }

  // ---------- 复位 + 收尾 ----------
  if (device && !noRestore) {
    header('复位 — 清屏回时钟 + 空闲呼吸（D16：设备不会自动恢复旧文字）')
    if (textSent || stage === 'restore') {
      await device.sendFrame(CMD.PIXEL_SET, pixelClockPayload(TEXT_RGB))
      await sleep(300)
      console.log('  已发 0xEF 时钟帧清屏')
    }
    if (stage !== 'scroll') {
      // scroll 实验不覆盖灯效：保持插件当前灯效，避免实验后误以为灯效异常
      await device.sendFrameReliable(
        CMD.MOOD_SET,
        moodSetPayload({
          arrayIndex: device.arrayIndex,
          light: LIGHT.BREATHING,
          rgb: [0x1c, 0xff, 0xf8],
          brightness: 100,
          speed: 8,
        }),
      )
      await sleep(300)
      console.log('  已恢复空闲呼吸')
    }
  }
  device?.close()

  const writeWarns = warnings.filter((w) => w.includes('hid write failed') || w.includes('marked unusable'))
  check('HID 写入无失败告警', writeWarns.length === 0, writeWarns[0])

  const failed = checks.filter((c) => !c.ok)
  const summary = {
    stage,
    ok: failed.length === 0,
    durationMs: Date.now() - startedAt,
    checks,
    warnings,
    visualChecks: visual,
  }

  header(failed.length === 0 ? 'PASS — 机器可判项全部通过（目视项见下）' : `FAIL — ${failed.length} 项未通过`)
  if (visual.length > 0) {
    console.log('目视确认（照真机手册验收表逐项打勾）：')
    for (const v of visual) console.log(`  [ ] ${v}`)
  }
  if (jsonOut) {
    console.log('')
    console.log(JSON.stringify(summary, null, 2))
  }
  return failed.length === 0 ? 0 : 1
}

// ---------- CLI（放在末尾：确保常量初始化先完成） ----------
const args = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const stageArg = arg('stage') ?? 'all'
if (!(STAGES as readonly string[]).includes(stageArg)) {
  console.error(`未知 --stage "${stageArg}"，可用：${STAGES.join(' | ')}`)
  process.exitCode = 2
} else {
  const holdMs = Math.max(200, Number(arg('hold') ?? 1500) || 1500)
  const textWaitMs = Math.max(1_000, Number(arg('wait') ?? 12000) || 12000)
  const code = await main(
    stageArg as Stage,
    holdMs,
    textWaitMs,
    args.includes('--no-restore'),
    args.includes('--json'),
  )
  process.exitCode = code
}
