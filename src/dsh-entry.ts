/**
 * dsh (DeepSeek Harness / Cordis) 插件入口（v0.2 / PB.22，D02 面第 2 个宿主类型文件）。
 *
 * Cordis 插件契约：`export const name` + `export function apply(ctx)`。
 * ctx 鸭子类型自包含（同 index.ts 的 HostCtx 打法）——不 import 任何 cordis 包，CI 零宿主依赖。
 * 双入口文件形态（D21）：opencode 读 package.json main → src/index.ts（default 导出）；
 * Cordis 按契约找 named export apply → 本文件。两宿主面零交叉 import。
 *
 * 📌 PB.23 标定项：配置来源形态、项目目录锚点（location.directory/cwd 二选一或都无）、
 * 入口寻址（R10：必要时 package.json 增 exports 子路径）。
 *
 * 纪律（AGENTS.md 铁律）：
 * - 零反向注入：approval/request 恒 next() 转发（events/dsh.ts §10.4 纪律）
 * - 任何失败静默降级，绝不抛进宿主（apply 全程 try/catch 兜底）
 * - 生命周期：ctx.effect 登记disposer——卸载/HMR 自动退订 + 停泵 + 关设备 + 停面板
 */
import { assembleCore, type AssembledCore, type PluginOptions } from './assemble.ts'
import { attachDshEvents } from './events/dsh.ts'
import type { PixelBarDevice } from './hid/device.ts'
import type { DeviceLogger } from './hid/types.ts'
import type { Clock } from './clock.ts'

export const name = 'pixelbar-one-look'

/** Cordis 服务注入：读取已有会话标题需要 sessions + sessionTitle（PB.32 冷启动播种）。
 *  仅声明 Host 服务；不 import cordis 类型，CI 仍零宿主依赖。 */
export const inject = ['sessions', 'sessionTitle']

/** 宿主注入 ctx 的最小形态（鸭子类型；运行时字段缺失/不可读时全部静默降级）
 * ⚠️ Cordis ctx 是 Proxy：未声明 inject 的服务属性【读取即抛错】（装载死因实证 2026-11-17：
 *    "cannot get property 'location' without inject"）——一切属性访问必须走 prop() 安全读取器 */
interface DshCtx {
  on?: (name: string, cb: (...args: any[]) => any) => unknown
  effect?: (init: () => unknown) => unknown
  log?: { info?(msg: string): void; warn?(msg: string): void; error?(msg: string): void }
  location?: { directory?: unknown }
  cwd?: unknown
  sessions?: { list?: () => unknown[] }
  sessionTitle?: { get?: (session: unknown) => unknown }
}

/** 安全属性读取：宿主 Proxy 的 get 可能抛错（Cordis 服务属性需 inject）——抛错 = 视为不存在 */
const prop = (obj: unknown, key: string): unknown => {
  try {
    return (obj as Record<string, unknown> | null | undefined)?.[key]
  } catch {
    return undefined
  }
}

/** 测试注入口（同 PixelBarDevice.fromTransport 的测试可测性角色，测试设计 §2） */
export interface EntryHooks {
  openDevice?: () => Promise<PixelBarDevice | null>
  clock?: Clock
}

const strOf = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

/** 冷启动读取已有会话标题（PB.32）：session/title 是 log-only 事件，插件启动前的标题不会补发；
 *  通过 ctx.sessions.list() + ctx.sessionTitle.get(session) 播种，当前这一轮完成即可用真实页签名。
 *  任何服务缺失/Proxy 读错/畸形都返回空数组（铁律 1）。 */
export function readSessionTitles(ctx: unknown): Array<{ id: string; title: string }> {
  try {
    const sessions = prop(ctx, 'sessions') as DshCtx['sessions']
    const titleSvc = prop(ctx, 'sessionTitle') as DshCtx['sessionTitle']
    if (typeof sessions?.list !== 'function' || typeof titleSvc?.get !== 'function') return []
    const list = sessions.list()
    if (!Array.isArray(list)) return []
    const out: Array<{ id: string; title: string }> = []
    for (const session of list) {
      const id = strOf(prop(session, 'id'))
      if (!id) continue
      const title = strOf(prop(titleSvc.get(session), 'title'))
      if (title) out.push({ id, title })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 单会话标题读取（PB.33）：turn 边界动态兜底——服务缺失/Proxy 读错/畸形一律 null（铁律 1）。
 * 覆盖「重启后旧会话的 log-only session/title 不会补发」：turn/start 时直接问标题服务。
 */
export function readSessionTitle(ctx: unknown, session: unknown): string | null {
  try {
    const titleSvc = prop(ctx, 'sessionTitle') as DshCtx['sessionTitle']
    if (typeof titleSvc?.get !== 'function') return null
    return strOf(prop(titleSvc.get(session), 'title'))
  } catch {
    return null
  }
}

/**
 * 配置读取（官方文档 develop/basic/config 实测定案 2026-11-17）：
 * Cordis 经 apply(ctx, config) 第二参传入，非 ctx.config。
 * 📌 兼容「插件配置块」与「扁平 config」双形态（正式 schema 校验留 v0.2.1，当前自身类型防御）。
 */
function readOptions(config: unknown): PluginOptions {
  const box = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
  const scopedRaw = box['pixelbar-one-look'] ?? box.pixelbarOneLook
  const scoped =
    scopedRaw && typeof scopedRaw === 'object' ? (scopedRaw as Record<string, unknown>) : null
  const src = scoped ?? box
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : undefined,
    debug: typeof src.debug === 'boolean' ? src.debug : undefined,
    logEvents: typeof src.logEvents === 'boolean' ? src.logEvents : undefined,
    monitor: typeof src.monitor === 'boolean' ? src.monitor : undefined,
    monitorPort: num(src.monitorPort),
  }
}

/**
 * 入口实现（apply 与测试共用）：装配 → 接线 → 托管 → 上电。
 * apply 外层再兜一次 try/catch——本函数已自带降级，双保险成本为零。
 */
export function startPixelbar(ctx: DshCtx, config?: unknown, hooks: EntryHooks = {}): void {
  let core: AssembledCore | null = null
  let detach: (() => void) | null = null
  try {
    const opts = readOptions(config)
    // 宿主属性一次性安全读取（Cordis Proxy 陷阱：未 inject 的服务属性读取即抛错）
    const rawOn = prop(ctx, 'on')
    const rawEffect = prop(ctx, 'effect')
    const rawLog = prop(ctx, 'log')

    const logger: DeviceLogger = {
      warn: (msg, err) => {
        if (opts.debug) (rawLog as DshCtx['log'])?.warn?.(`[pixelbar] ${msg}${err ? ` ${String(err)}` : ''}`)
      },
      debug: (msg) => {
        if (opts.debug) (rawLog as DshCtx['log'])?.info?.(`[pixelbar] ${msg}`)
      },
    }

    core = assembleCore(opts, {
      logger,
      openDevice: hooks.openDevice,
      clock: hooks.clock,
      // monitor 端口接管（D12）：新实例接管端口 → 本实例先行退订（标志位兜底）
      onShutdownRequest: () => {
        try {
          detach?.()
        } catch {
          // 静默
        }
      },
    })
    const { diag, engine, monitor, loop } = core

    // 实测校准通道（同 index.ts）：ctx 真实形态直接进面板——PB.23 标定的第一手数据
    const ctxKeys = Object.keys(ctx ?? {})
    const onKeys = typeof rawOn === 'function' ? 'yes' : 'MISSING'
    diag(`dsh apply entered · ctx keys: [${ctxKeys.sort().join(',')}] · on: ${onKeys}`)

    if (opts.enabled === false) {
      diag('plugin disabled (enabled:false)')
      return
    }

    // 冷启动播种已有标题（PB.32）：当前会话标题早于插件启动时，session/title 不会补发。
    const seededTitles = readSessionTitles(ctx)
    for (const { id, title } of seededTitles) engine.setSessionTitle(id, title)
    if (seededTitles.length > 0) diag(`session title seed ${seededTitles.length}`)

    // 项目目录锚点（📌 PB.23）：location.directory（opencode 同源）?? cwd —— liveness/JSONL dump 落点
    // ⚠️ 经 prop() 安全读取（本次装载死因：ctx.location 直接读取抛 "without inject"）
    const projectDir = strOf(prop(prop(ctx, 'location'), 'directory')) ?? strOf(prop(ctx, 'cwd'))
    if (projectDir) diag(`project dir: ${projectDir}`)

    // liveness 信标：apply 执行即留痕（temp/ 为 gitignored 本地观测区；无锚点跳过）
    const writeText = (rel: string, text: string): void => {
      if (!projectDir) return
      const sep = projectDir.endsWith('/') || projectDir.endsWith('\\') ? '' : '/'
      void (async () => {
        try {
          const { appendFileSync } = await import('node:fs')
          appendFileSync(`${projectDir}${sep}${rel}`, text, 'utf8')
          if (rel.includes('liveness')) diag('liveness ok')
        } catch (err) {
          if (rel.includes('liveness')) diag(`liveness failed: ${String(err).slice(0, 150)}`)
          // 静默：捕获/信标绝不能影响宿主
        }
      })()
    }
    if (projectDir) {
      writeText('temp/plugin-liveness.log', `[${new Date().toISOString()}] pid=${process.pid} dsh-apply\n`)
    } else {
      diag('liveness skipped: no project dir')
    }

    // 事件接线：raw 留痕（面板 + 可选 JSONL dump）→ 归一 → noteEvent 留痕 → 泵
    const onRaw = (channel: string, args: readonly unknown[]): void => {
      try {
        monitor.noteRaw({ type: channel, data: args }) // data 字段进对象；面板 raw 行显示通道名
      } catch {
        // 静默
      }
      if (opts.logEvents) {
        // 标定双通道（PB.23）：JSONL 落盘依赖项目目录锚点（📌 dsh ctx 未必携带）——
        // monitor diag 行是防断粮兜底，无锚点也保证拿到 payload 形态
        try {
          monitor.pushDiag(`raw ${channel} :: ${JSON.stringify(args).slice(0, 300)}`)
        } catch {
          // 静默
        }
        writeText('temp/dsh-events.jsonl', `${JSON.stringify({ t: Date.now(), channel, args })}\n`)
      }
    }
    const emit = (ie: import('./events/types.ts').InternalEvent): void => {
      try {
        monitor.noteEvent(ie)
      } catch {
        // 静默
      }
      loop.handleEvent(ie)
    }
    const on = typeof rawOn === 'function' ? (rawOn as DshCtx['on']) : undefined
    if (!on) {
      diag('NO ctx.on: zero subscriptions, lights stay idle')
    } else {
      // 窄化后显式装箱：DshEventCtx.on 必选 vs DshCtx.on 可选——TS 不对整对象收窄，取 const 再传
      // PB.33：turn 边界动态读标题（重启后旧会话不补发 title 事件的兜底）
      detach = attachDshEvents({ on }, emit, onRaw, {
        resolveTitle: (session) => readSessionTitle(ctx, session),
      })
    }

    // 生命周期托管（Cordis Effect）：init 返回 disposer，卸载/HMR 自动清场
    const effect = typeof rawEffect === 'function' ? (rawEffect as DshCtx['effect']) : undefined
    if (effect) {
      effect(() => () => {
        try {
          detach?.()
        } catch {
          // 静默
        }
        void core?.stop()
      })
    } else {
      diag('NO ctx.effect: cleanup relies on monitor shutdown only')
    }

    core.start()
  } catch (err) {
    // 铁律 1：装配任何失败静默降级，绝不抛进宿主；diag 可用则留痕。
    // 教训固化（DEVLOG 会话九）：兜底 catch 必须留至少一条可达诊断通道——
    // console.error 在 CLI 环境直达 stderr；桌面版 GUI 虽吞掉，也无副作用（一行/真失败才打）
    console.error('[pixelbar-one-look] dsh apply failed (iron rule 1):', err)
    try {
      core?.diag(`dsh apply failed: ${String(err).slice(0, 150)}`)
    } catch {
      // 静默
    }
    try {
      detach?.()
    } catch {
      // 静默
    }
    try {
      void core?.stop()
    } catch {
      // 静默
    }
  }
}

/** Cordis 插件契约入口（薄壳）：apply(ctx, config)——配置经第二参数传入（官方文档 develop/basic/config） */
export function apply(ctx: unknown, config?: unknown): void {
  try {
    startPixelbar((ctx ?? {}) as DshCtx, config)
  } catch {
    // 铁律 1 双保险（startPixelbar 自带兜底，此处理论不可达）
  }
}
