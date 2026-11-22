/**
 * pixelbar-one-look 插件入口 —— 唯一允许接触 opencode 宿主 API 的文件（跨平台隔离纪律 D02）。
 *
 * 宿主协议（鸭子类型，自包含）：default 导出 { id, setup(ctx) => cleanup }；
 * ctx = { event.subscribe({signal}) 异步事件流, options 插件选项, session.list(), log }。
 * opencode server（Bun）直接加载 TS 源码 —— 发布形态即源码，无需构建。
 *
 * 纪律（AGENTS.md 铁律）：
 * - 零反向注入：只消费事件（铁律 2）
 * - 任何失败静默降级，绝不抛进宿主（铁律 1）
 * - cleanup 幂等：abort 订阅 + 停泵 + 关设备
 */
import { assembleCore, type PluginOptions } from './assemble.ts'
import { createOpencodeNormalizer } from './events/opencode.ts'
import type { DeviceLogger } from './hid/types.ts'

/**
 * 插件文件自身的锚点已废弃（v2 实测：宿主 loader 改写 import.meta.url，路径解析漂移到项目外）。
 * 文件路径唯一可靠锚 = ctx.location.directory（宿主告知的项目目录）。
 */
const strOf = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

function resolveInProject(projectDir: string | null, rel: string): string | null {
  if (!projectDir) return null
  const sep = projectDir.endsWith('/') || projectDir.endsWith('\\') ? '' : '/'
  return `${projectDir}${sep}${rel}`
}

/** 目录 basename（项目名兜底；D13 别名基准） */
const dirName = (dir: string): string => {
  const clean = dir.replace(/[\\/]+$/, '')
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return i >= 0 ? clean.slice(i + 1) : clean
}

/** 宿主注入 ctx 的最小形态（运行时字段缺失时全部静默降级） */
interface HostCtx {
  event?: {
    subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
  options?: Record<string, unknown>
  /** 官方 Context.location（v2 实测）：宿主告知本项目目录——文件锚点唯一可靠来源 */
  location?: { directory?: unknown }
  /** 会话台账（v2 官方）：冷启动播种 title/parentID（自动标题不走事件，list 兜底） */
  session?: {
    list?: (input?: Record<string, unknown>) => Promise<unknown>
  }
  log?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

async function setupImpl(ctx: HostCtx): Promise<() => Promise<void>> {
  const opts: PluginOptions = (ctx.options ?? {}) as PluginOptions

  const logger: DeviceLogger = {
    warn: (msg, err) => {
      if (opts.debug) ctx.log?.warn(`[pixelbar] ${msg}${err ? ` ${String(err)}` : ''}`)
    },
    debug: (msg) => {
      if (opts.debug) ctx.log?.info(`[pixelbar] ${msg}`)
    },
  }

  // 装配线（v0.2/PB.22 抽取 assembleCore——五件套 engine/holder/monitor/调度器/泵移平台中立层；
  // 本面只留事件流订阅/冷启动播种/清理等宿主差异逻辑）。D12 端口接管协议已内置：
  // 新实例 POST /shutdown 接管端口 → 旧实例先 abort 订阅流（onShutdownRequest）→ 停泵 → 关设备
  const controller = new AbortController()
  const core = assembleCore(opts, {
    logger,
    onShutdownRequest: () => controller.abort(),
  })
  const { diag, engine, monitor, loop } = core

  // 实测校准：ctx 真实形态（鸭子假设 vs 宿主实际，面板直接可见）
  const ctxKeys = Object.keys(ctx ?? {})
  const eventKeys = ctx?.event ? Object.keys(ctx.event as object) : null
  diag(`setup entered · ctx keys: [${ctxKeys.sort().join(',')}]`)
  diag(`ctx.event keys: [${eventKeys ? eventKeys.sort().join(',') : 'undefined'}]`)

  // 文件锚点（v2 实测）：import.meta.url 被宿主 loader 改写不可用；ctx.location.directory 是唯一可靠项目路径
  const projectDir = strOf(ctx?.location?.directory)
  if (projectDir) diag(`project dir: ${projectDir}`)

  // liveness 信标：setup 执行即留痕（temp/ 为 gitignored 本地观测区，失败原因进诊断通道）
  try {
    const { appendFileSync } = await import('node:fs')
    const p = resolveInProject(projectDir, 'temp/plugin-liveness.log')
    if (p) {
      appendFileSync(p, `[${new Date().toISOString()}] pid=${process.pid} setup\n`, 'utf8')
      diag(`liveness ok → ${p}`)
    } else {
      diag('liveness skipped: no project dir')
    }
  } catch (err) {
    diag(`liveness failed: ${String(err).slice(0, 150)}`)
    // 第二通道：monitor 可能起不来（诊断盲区），stderr 兜底
    console.error('[pixelbar-one-look] liveness failed:', err)
  }

  if (opts.enabled === false) {
    diag('plugin disabled (enabled:false)')
    return () => Promise.resolve()
  }

  // 后台工作追踪（PB.31）：有状态归一化工厂——shell.created/exited 归属登记 +
  // 抑制"轮次完成但后台脚本仍在跑"的 completed；宽限期到点经 onLate 补发
  const norm = createOpencodeNormalizer({
    onLate: (events) => {
      for (const ie of events) {
        monitor.noteEvent(ie)
        loop.handleEvent(ie)
      }
    },
  })

  const consuming = (async (): Promise<void> => {
    try {
      const stream = ctx.event?.subscribe?.({ signal: controller.signal })
      diag(stream ? `stream acquired (${typeof stream})` : 'NO stream: ctx.event?.subscribe?.() returned undefined')
      if (!stream) return // 宿主无事件流（异常环境）：灯常驻 idle，不报错
      for await (const ev of stream) {
        if (controller.signal.aborted) break
        monitor.noteRaw(ev) // scope 实测通道：观察事件 location 是项目级还是全局级
        if (opts.logEvents) {
          try {
            const { appendFileSync } = await import('node:fs')
            const p = resolveInProject(projectDir, 'temp/events.jsonl')
            if (p) appendFileSync(p, `${JSON.stringify(ev)}\n`, 'utf8')
          } catch {
            // 写文件失败（目录不存在等）：静默——捕获模式绝不能影响宿主
          }
        }
        for (const ie of norm(ev)) {
          monitor.noteEvent(ie)
          loop.handleEvent(ie)
        }
      }
    } catch (err) {
      diag(`event loop exited: ${String(err).slice(0, 150)}`)
    }
  })()

  // 上电（装配线内置 D12 接管协议）：monitor 绑定 + 初始 idle 呼吸
  core.start()

  // 冷启动播种（v2.3.0 实测）：自动标题/子会话关系不走事件——session.list 一次拉齐 title/parentID
  // （失败静默：别名退回项目名，不阻塞任何输出）
  const seedSessions = async (): Promise<void> => {
    try {
      const list = ctx.session?.list
      if (!list || !projectDir) return
      const page = (await list({ directory: projectDir, limit: 100 })) as
        | Record<string, unknown>
        | unknown[]
      const box = page as { data?: unknown; items?: unknown; sessions?: unknown } | undefined
      const rawItems = Array.isArray(page)
        ? page
        : ((box?.data as { items?: unknown } | undefined)?.items ??
          box?.data ??
          box?.items ??
          box?.sessions ??
          [])
      const items = Array.isArray(rawItems) ? (rawItems as Array<Record<string, unknown>>) : []
      let seeded = 0
      let children = 0
      const titles: string[] = []
      for (const raw of items) {
        const id = strOf(raw.id) ?? strOf(raw.sessionID)
        if (!id) continue
        const parentID = strOf(raw.parentID)
        const title = strOf(raw.title)
        engine.registerSession({
          id,
          title,
          parentID,
          project: dirName(projectDir),
        })
        seeded++
        if (parentID) children++
        if (title) titles.push(title)
      }
      diag(
        `session list seeded ${seeded}/${items.length} (children=${children}) titles=[${titles.slice(0, 3).join(' | ')}]`,
      )
    } catch (err) {
      diag(`session list failed: ${String(err).slice(0, 150)}`)
    }
  }
  void seedSessions()

  let cleaned = false
  return async () => {
    if (cleaned) return
    cleaned = true
    controller.abort()
    try {
      // PB.22 装配线：loop/holder/monitor 统一由 core.stop() 按“停泵→关设备→停面板”次序幂等停机
      // （此前误留旧三行停机，holder 已移入 core 未解构——cleanup 抛 ReferenceError 会拖垮宿主插件重载）
      await core.stop()
    } catch {
      // 静默（铁律 1：清理失败绝不抛进宿主）
    }
    try {
      await consuming
    } catch {
      // 静默
    }
  }
}

/**
 * 宿主入口（外层铁律 1 兜底，PB.24 / 2026-11-17 事故立规）：
 * 装配任何失败 → 静默降级为 no-op 插件（stderr 留痕）——绝不让 setup 抛错拖垮宿主插件重载、
 * 毒掉该目录 provider 注册表（实证案例见 DEVLOG 会话八）。
 */
async function setup(ctx: HostCtx): Promise<() => Promise<void>> {
  try {
    return await setupImpl(ctx)
  } catch (err) {
    try {
      console.error('[pixelbar-one-look] setup failed (iron rule 1):', err)
    } catch {
      // 静默
    }
    return () => Promise.resolve()
  }
}

export default {
  id: 'pixelbar-one-look',
  setup,
}
