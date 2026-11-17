/**
 * assembleCore —— 平台中立装配线（v0.2 / PB.22，从 index.ts 抽取）。
 *
 * 宿主面（index.ts = opencode / dsh-entry.ts = dsh）各自薄壳：提供事件源、配置、日志、
 * 生命周期挂钩，共用本装配。抽取纪律（PB.22 DoD）：index.ts 行为零变化——
 * 装配顺序、monitor 端口接管协议（D12）、stop 次序逐行保持；126 既有用例不动即证。
 *
 * 本文件平台中立（D02 核心面）：禁止 import 任何宿主/cordis/opencode 类型。
 */
import { systemClock, type Clock } from './clock.ts'
import { DeviceHolder, PixelBarDevice } from './hid/device.ts'
import { SILENT_LOGGER, type DeviceLogger } from './hid/types.ts'
import { OutputScheduler } from './lights/effects.ts'
import { GlanceLoop } from './lights/loop.ts'
import { AggregationEngine } from './lights/states.ts'
import { MonitorHub } from './monitor/monitor.ts'

/** 插件配置（两宿主同构；dsh 侧来源形态 📌 PB.23 标定） */
export interface PluginOptions {
  /** false 时空转（默认启用） */
  enabled?: boolean
  /** 调试：设备层 warn/debug 输出到宿主日志（默认静默） */
  debug?: boolean
  /** 事件捕获：原始事件 JSONL 追加到 temp/（实测校准用） */
  logEvents?: boolean
  /** 本地网页监视器（默认开启）：127.0.0.1:monitorPort 的虚拟 PixelBar 面板 */
  monitor?: boolean
  monitorPort?: number
}

export interface AssembleHooks {
  /** 设备打开工厂（默认真机 PixelBarDevice.open；测试注入 MockTransport） */
  openDevice?: () => Promise<PixelBarDevice | null>
  /** 设备层日志（宿主面按 opts.debug 门控后传入；缺省静默） */
  logger?: DeviceLogger
  /** 时钟注入（默认系统时钟；测试 VirtualClock 倍速） */
  clock?: Clock
  /** monitor POST /shutdown 接管请求 → 宿主面先行退订/abort（先于停泵关设备，D12） */
  onShutdownRequest?: () => void
}

export interface AssembledCore {
  opts: PluginOptions
  engine: AggregationEngine
  monitor: MonitorHub
  loop: GlanceLoop
  /** 诊断通道（面板 diag 行；自身失败静默） */
  diag: (msg: string) => void
  /** 上电：loop.start（初始 idle 呼吸）+ monitor.start（fire-and-forget，失败 stderr 兜底） */
  start(): void
  /** 幂等停机：停泵 → 关设备 → 停面板（调用方另管自己的订阅 abort） */
  stop(): Promise<void>
}

export function assembleCore(opts: PluginOptions, hooks: AssembleHooks = {}): AssembledCore {
  const logger = hooks.logger ?? SILENT_LOGGER
  const clock = hooks.clock ?? systemClock

  const engine = new AggregationEngine()
  const holder = new DeviceHolder(hooks.openDevice ?? (() => PixelBarDevice.open(logger)), logger)
  const monitor = new MonitorHub()
  const diag = (msg: string): void => {
    try {
      monitor.pushDiag(msg)
    } catch {
      // 诊断通道自身失败：静默
    }
  }
  // 控制台雏形（D14）：引擎台账注入——/state 的 stats 字段（会话状态 + 完成队列）
  monitor.setStatsProvider(() => engine.stats())

  // 输出调度：sink = monitor.teeDevice(holder)（帧序列经 monitor 汇点透传真机；无真机时面板为唯一输出）
  const scheduler = new OutputScheduler(
    async () => monitor.teeDevice(await holder.get()),
    logger,
  )
  const loop = new GlanceLoop(engine, scheduler, clock)

  // 端口接管协议（D12）：绑定清理回调须先于 monitor.start——宿主热重载不调旧 cleanup，
  // 新实例经 POST /shutdown 接管端口时，旧实例经此回调退订（onShutdownRequest）→ 停泵 → 关设备
  monitor.onShutdown = () => {
    try {
      hooks.onShutdownRequest?.()
      loop.stop()
      holder.stop()
    } catch {
      // 静默
    }
  }

  let started = false
  let stopped = false
  return {
    opts,
    engine,
    monitor,
    loop,
    diag,
    start(): void {
      if (started || stopped) return
      started = true
      if (opts.monitor !== false) {
        // 异步接管+绑定，不阻塞 setup；失败经 stderr 兜底可见（diag 依赖 server，server 失败时盲区）
        void monitor.start(opts.monitorPort ?? 18789).then((ok) => {
          if (!ok) console.error('[pixelbar-one-look] monitor failed to bind any port (18789-18791)')
        })
      }
      loop.start() // 初始 idle 呼吸灯上电（无设备时静默跳过）
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      loop.stop()
      holder.stop()
      monitor.stop()
    },
  }
}
