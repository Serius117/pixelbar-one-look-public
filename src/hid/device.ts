/**
 * PixelBarDevice —— HID 设备层：发现 / 打开 / 单写者写队列 / 三连发 / queryMood / 降级。
 *
 * 纪律（AGENTS.md 架构铁律 + design.md §5）：
 * - 单写者：全部 HID 写入经 enqueue 的 Promise 链串行化
 * - 静默降级：任何失败不 reject 出 sendFrame*，绝不抛进宿主进程
 * - arrayIndex 必须运行时查询，查询失败宁弃用设备不猜值（DECISIONS D04）
 * - 平台差异（node-hid）全部封装在本文件（架构铁律 5）
 */
import type { DeviceLogger, HidTransport } from './types.ts'
import {
  CMD,
  CONTROL_INTERFACE,
  MAX_PAYLOAD,
  PIDS,
  VENDOR_USAGE_PAGE,
  VID,
  buildFrame,
  parseDeviceFrame,
  parseMoodQueryPayload,
  type MoodState,
} from './protocol.ts'

const TRIPLE_SEND_COUNT = 3
const TRIPLE_GAP_MS = 30
const MOOD_QUERY_RETRIES = 3
const MOOD_QUERY_TIMEOUT_MS = 500
const READ_POLL_INTERVAL_MS = 10
const FATAL_WRITE_FAILURES = 3

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 可注入 sleep（测试虚拟时钟联动三连发 30ms 间隔；默认系统 setTimeout） */
export type SleepFn = (ms: number) => Promise<void>
export interface DeviceOptions {
  sleep?: SleepFn
}

// ---------- node-hid 动态加载（DECISIONS D05：optionalDependency，失败降级） ----------

export interface HidDeviceInfo {
  vendorId: number
  productId: number
  path: string
  /** node-hid v3 真实字段名（2026-11-16 真机枚举实证：`interface`，非 interfaceNumber） */
  interface?: number
  /** 兼容旧形状/测试替身；真实 node-hid 不返回此字段 */
  interfaceNumber?: number
  usagePage?: number
}
interface NodeHidDevice {
  write(data: Uint8Array | number[] | Buffer): number
  readTimeout(ms: number): number[]
  close(): void
}
/**
 * node-hid v3 实测形状（2026-11-16 本机实证）：枚举是**顶层** devices() 函数，
 * HID 类只做构造器（v2 的静态 HID.devices() 已移除）——鸭子假设以此为准。
 */
interface NodeHidModule {
  devices(): HidDeviceInfo[]
  HID: new (path: string) => NodeHidDevice
}

export async function loadNodeHid(logger: DeviceLogger): Promise<NodeHidModule | null> {
  try {
    // `as string` 断开字面量类型：node-hid 未安装时 tsc 也不报错（optional 依赖哲学）
    const mod = (await import('node-hid' as string)) as unknown as NodeHidModule | undefined
    if (!mod || typeof mod.devices !== 'function' || typeof mod.HID !== 'function') {
      logger.warn('node-hid loaded but unexpected shape (need v3: top-level devices() + HID constructor)')
      return null
    }
    return mod
  } catch (err) {
    logger.warn('node-hid unavailable, HID output disabled', err)
    return null
  }
}

/**
 * 候选排序（2026-11-16 真机实证修正）：同一个 interface 4 下有两个 collection，
 * Col01(usagePage 0xFF13) **写即 ERROR_INVALID_FUNCTION**，只有 Col02(0xFF14) 可写。
 * 故 0xFF14 最优先；interface 4 次之；两者都不是不猜（红线）。
 */
export function rankPixelBarDevices(devices: HidDeviceInfo[]): HidDeviceInfo[] {
  const ifaceOf = (d: HidDeviceInfo): number | undefined => d.interface ?? d.interfaceNumber
  const rankOf = (d: HidDeviceInfo): number | null => {
    if (d.usagePage === VENDOR_USAGE_PAGE) return 0
    if (ifaceOf(d) === CONTROL_INTERFACE) return 1
    return null
  }
  return devices
    .filter((d) => d.vendorId === VID && PIDS.includes(d.productId))
    .map((d, i) => ({ d, i, rank: rankOf(d) }))
    .filter((x): x is { d: HidDeviceInfo; i: number; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.d)
}

/** 首选候选（枚举用；真实打开按 rankPixelBarDevices 顺序逐个试） */
export function pickPixelBarDevice(devices: HidDeviceInfo[]): HidDeviceInfo | null {
  return rankPixelBarDevices(devices)[0] ?? null
}

/** node-hid 的 HidTransport 实现：write 同步包装；read 用 readTimeout(0) 轮询避免阻塞事件循环 */
class NodeHidTransport implements HidTransport {
  private readonly hid: NodeHidDevice

  constructor(hid: NodeHidDevice) {
    this.hid = hid
  }

  write(data: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.hid.write(data))
      } catch (err) {
        reject(err)
      }
    })
  }

  async read(timeoutMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const got = this.hid.readTimeout(0) // 非阻塞立即返回
      if (got.length > 0) return Uint8Array.from(got)
      await sleep(READ_POLL_INTERVAL_MS)
    }
    return null
  }

  close(): void {
    try {
      this.hid.close()
    } catch {
      // 已拔出/已关闭：静默
    }
  }
}

// ---------- queryMood（0x6A：arrayIndex 运行时查询，红线 1） ----------

// 0x6A 查询帧的 payload 格式未抓包标定（design.md §7.3），先按空 payload；
// PB.04 真机标定后本常量是唯一修改点。
const MOOD_QUERY_PAYLOAD = new Uint8Array(0)

export async function queryMood(
  transport: HidTransport,
  logger: DeviceLogger,
  timeoutMs = MOOD_QUERY_TIMEOUT_MS,
): Promise<MoodState | null> {
  try {
    await transport.write(buildFrame(CMD.MOOD_QUERY, MOOD_QUERY_PAYLOAD))
  } catch (err) {
    logger.warn('mood query write failed', err)
    return null
  }
  // 真机实证：0x6B 设置后设备会回 0x6B 帧，与 0x6A 应答同队列 —— 非目标帧跳过，限时继续等
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = await transport.read(deadline - Date.now())
    if (!frame) return null
    const parsed = parseDeviceFrame(frame)
    if (parsed?.cmd === CMD.MOOD_QUERY) return parseMoodQueryPayload(parsed.payload)
    logger.debug(`mood query skipping frame cmd=0x${(parsed?.cmd ?? 0).toString(16)}`)
  }
  return null
}

// ---------- PixelBarDevice ----------

export class PixelBarDevice {
  /** 写队列尾：全部写入串行化的单写者核心 */
  private queueTail: Promise<unknown> = Promise.resolve()
  private consecutiveWriteFailures = 0
  private fatalTriggered = false
  private transportClosed = false
  /** fatal（连续写失败≥3）时回调；DeviceHolder 注册以清引用 */
  onFatal: (() => void) | null = null

  private readonly transport: HidTransport
  private readonly log: DeviceLogger
  readonly arrayIndex: number
  private readonly sleepImpl: SleepFn

  private constructor(
    transport: HidTransport,
    log: DeviceLogger,
    arrayIndex: number,
    sleepImpl: SleepFn,
  ) {
    this.transport = transport
    this.log = log
    this.arrayIndex = arrayIndex
    this.sleepImpl = sleepImpl
  }

  /**
   * 经已打开的 transport 建立可用设备：queryMood ≤3 次重试取 arrayIndex。
   * 全部失败 → close + 返回 null（D04：错值被设备静默忽略，宁可不用也不猜）。
   * （node-hid 发现/打开链路见 static open；本入口供测试与真机共用。）
   */
  static async fromTransport(
    transport: HidTransport,
    logger: DeviceLogger,
    opts?: DeviceOptions,
  ): Promise<PixelBarDevice | null> {
    for (let i = 0; i < MOOD_QUERY_RETRIES; i++) {
      const state = await queryMood(transport, logger)
      if (state) return new PixelBarDevice(transport, logger, state.arrayIndex, opts?.sleep ?? sleep)
    }
    transport.close()
    logger.warn(`mood query failed x${MOOD_QUERY_RETRIES}, device unusable (D04: no guessing)`)
    return null
  }

  /** 真机入口：node-hid 发现 → 按候选顺序打开（首个可写即用）；任一环失败返回 null */
  static async open(logger: DeviceLogger, opts?: DeviceOptions): Promise<PixelBarDevice | null> {
    const mod = await loadNodeHid(logger)
    if (!mod) return null
    const candidates = rankPixelBarDevices(mod.devices())
    for (const picked of candidates) {
      let hid: NodeHidDevice
      try {
        hid = new mod.HID(picked.path)
      } catch (err) {
        logger.warn('pixelbar open failed (busy? unplugged?), silent degrade', err)
        continue
      }
      const dev = await PixelBarDevice.fromTransport(new NodeHidTransport(hid), logger, opts)
      if (dev) return dev
      logger.debug(
        `candidate not usable: usagePage=0x${(picked.usagePage ?? 0).toString(16)}` +
          ` if=${picked.interface ?? picked.interfaceNumber ?? '?'}`,
      )
    }
    return null
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task) // 前任务失败不阻断队列
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async writeOnce(frame: Uint8Array): Promise<boolean> {
    try {
      await this.transport.write(frame)
      this.consecutiveWriteFailures = 0
      return true
    } catch (err) {
      this.consecutiveWriteFailures++
      this.log.warn(`hid write failed (${this.consecutiveWriteFailures}/${FATAL_WRITE_FAILURES})`, err)
      if (this.consecutiveWriteFailures >= FATAL_WRITE_FAILURES) this.markFatal()
      return false
    }
  }

  private markFatal(): void {
    if (this.fatalTriggered) return
    this.fatalTriggered = true
    this.close()
    this.log.warn(`device marked unusable after ${FATAL_WRITE_FAILURES} consecutive write failures`)
    this.onFatal?.()
  }

  /** 单发一帧；写失败静默吞（warn 日志），不 reject */
  async sendFrame(cmd: number, payload: Uint8Array): Promise<void> {
    const frame = buildFrame(cmd, payload) // 超限同步 throw → reject（构造错误应显式暴露）
    await this.enqueue(() => this.writeOnce(frame))
  }

  /** 三连发（同帧 ×3、间隔 30ms，队列内原子）——灯效专用抗丢包（protocol.md 实测结论） */
  async sendFrameReliable(cmd: number, payload: Uint8Array): Promise<void> {
    const frame = buildFrame(cmd, payload)
    await this.enqueue(async () => {
      for (let i = 0; i < TRIPLE_SEND_COUNT && !this.fatalTriggered; i++) {
        if (i > 0) await this.sleepImpl(TRIPLE_GAP_MS)
        await this.writeOnce(frame)
      }
    })
  }

  /** 再查一次灯效状态（调试/校正用）；性能敏感路径不调用 */
  async queryMood(timeoutMs = MOOD_QUERY_TIMEOUT_MS): Promise<MoodState | null> {
    return queryMood(this.transport, this.log, timeoutMs)
  }

  get closed(): boolean {
    return this.fatalTriggered || this.transportClosed
  }

  close(): void {
    if (this.transportClosed) return
    this.transportClosed = true
    this.transport.close()
  }
}

// ---------- DeviceHolder（可用性门面：lazy 重开 + 60s 节流兜底） ----------

export class DeviceHolder {
  private device: PixelBarDevice | null = null
  private lastAttemptTs = 0
  private stopped = false
  private readonly openFn: () => Promise<PixelBarDevice | null>
  private readonly log: DeviceLogger
  private readonly retryIntervalMs: number

  constructor(
    openFn: () => Promise<PixelBarDevice | null>,
    log: DeviceLogger,
    retryIntervalMs = 60_000,
  ) {
    this.openFn = openFn
    this.log = log
    this.retryIntervalMs = retryIntervalMs
  }

  /** 拿可用设备；不可用返回 null（调用方跳过输出即可）。open 失败后 retryIntervalMs 内不再重试 */
  async get(): Promise<PixelBarDevice | null> {
    if (this.stopped) return null
    if (this.device) return this.device
    if (Date.now() - this.lastAttemptTs < this.retryIntervalMs) return null
    this.lastAttemptTs = Date.now()
    try {
      this.device = await this.openFn()
    } catch (err) {
      this.log.warn('device open threw', err)
      this.device = null
    }
    if (this.device) this.device.onFatal = () => (this.device = null)
    return this.device
  }

  stop(): void {
    this.stopped = true
    this.device?.close()
    this.device = null
  }
}
