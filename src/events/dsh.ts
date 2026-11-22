/**
 * dsh (DeepSeek Harness / Cordis) 宿主事件 → InternalEvent 归一化适配器（v0.2 / PB.21，D02 面）。
 *
 * 【Phase 1 默认假设】payload 形态按 docs/dsh调研.md §6.2 的目录级知识编写，
 * 全部映射点标 📌——PB.23 真机 logEvents dump 标定后修订（同 opencode 侧 PB.04 打法）。
 * 本文件与 src/dsh-entry.ts 是 dsh 面仅有的两个允许接触宿主类型的文件（详细设计 §10.2，D02 扩展/D20）；
 * 不 import 任何 cordis/opencode 包——宿主 ctx 鸭子类型（同 index.ts 的 HostCtx 打法）。
 *
 * 与 opencode.ts 的结构差异（dsh 是多通道推送，opencode 是单流拉取）：
 * - 事件以 (channel, args[]) 到达：ctx.on(name, (...args) => ...) 逐通道订阅（attachDshEvents）；
 * - approval/request 是 waterfall：listener 收 (req, next)——恒 next() 转发纪律见 attachDshEvents。
 *
 * 防御原则（铁律 1）：未知通道 / 字段缺失 / 畸形 payload → 返回空数组静默忽略，绝不抛进宿主。
 * 工具失败 ≠ 会话失败（events/types.ts 失败两层哲学）：tools/result 只做工作活跃心跳。
 */
import type { InternalEvent } from './types.ts'

/** dsh 事件通道清单（详细设计 §10.3 表；PB.23 标定实证 2026-11-17）
 *  核心发现：turn/step/tool/approval 生命周期全部走 session/event（durable SessionEvent
 *  唯一出口，官方文档 session.md：'session/event'(session, event)），live agent/* 事件只有
 *  少量存在（inbox/claimed、turn-stopping、request-error 等）。
 *  实测否决记录：
 *  - agent/created：boot 期对每个空闲会话也发（假 working）——移除
 *  - agent/session-start：仅会话生命周期建立时发，不随每轮 turn 触发（真 working 信号 = turn/start）
 *  - agent/turn-stopping：改由 durable turn/end 承载完成信号（避免双完成进轮播队列）
 *  - approval/decided 无 live 事件：审计对 approval/asked/decided 均为 durable，走 session/event */
export const DSH_CHANNELS = [
  'session/created',
  'session/event',
  'agent/session-start',
  'agent/step',
  'tools/result',
  'agent/request-error',
  'agent/error',
  'approval/request',
  'agent/disposed',
  'agent/inbox/claimed',
] as const

export type DshChannel = (typeof DSH_CHANNELS)[number]

type Props = Record<string, any>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0
    ? v
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null

/** 对象化（数组/null/原始值一律 null——数组排除：dsh 多参 listener 会收到元组，逐元素扫描） */
const asProps = (v: unknown): Props | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Props) : null

/**
 * 遍历 args 元组每个对象元素，返回第一个命中非空字符串的候选值。
 * dsh 事件参数形状未标定（📌），故对整个元组做保守扫描而非绑定固定下标。
 */
function scan(args: readonly unknown[], pick: (p: Props) => unknown): string | null {
  for (const a of args) {
    const p = asProps(a)
    if (!p) continue
    const s = str(pick(p))
    if (s) return s
  }
  return null
}

/** 会话 ID 候选链（官方文档 + 实测形态：sessionID/sessionId 顶层 > session.id > agent.session.id >
 *  裸 p.id 末位——session/event 通道首参即 Session 对象 {id}，末位兜底避免 agent.id 误命中） */
const pickSessionID = (args: readonly unknown[]): string | null =>
  scan(args, (p) => {
    const s = asProps(p.session)
    const a = asProps(p.agent)
    const as = a ? asProps(a.session) : null
    return (
      p.sessionID ?? p.sessionId ?? s?.id ?? s?.sessionID ?? as?.id ?? as?.sessionID ?? a?.sessionID ?? a?.session ?? p.id
    )
  })

/** 会话标题候选链（session/created 播种台账 title，别名链 D13：title→project→S） */
const pickTitle = (args: readonly unknown[]): string | null =>
  scan(args, (p) => {
    const s = asProps(p.session)
    const a = asProps(p.agent)
    const as = a ? asProps(a.session) : null
    return p.title ?? s?.title ?? a?.title ?? as?.title
  })

/**
 * 子 Agent 过滤（D17 的 dsh 对应物，TC-DA3）：creator 非空 = 子 Agent（嵌套任务/工具场景），
 * 事件一律不聚合——防幽灵完成/抢占。📌 字段名形态假设，PB.23 标定。
 */
const pickCreator = (args: readonly unknown[]): string | null =>
  scan(args, (p) => {
    const a = asProps(p.agent)
    const s = asProps(p.session)
    return p.creator ?? a?.creator ?? s?.creator
  })

/** 工具名/步骤摘要（tool.started 心跳文本；台账记录用，v0.1.1 起 working 态无文字显示）
 *  session/event 通道的名称在信封 data 里（tool/call: data.name），live 通道在顶层/step/exec */
const pickToolText = (args: readonly unknown[]): string | null =>
  scan(args, (p) => {
    const step = asProps(p.step)
    const data = asProps(p.data)
    return (
      p.tool ?? p.name ?? p.toolName ?? step?.tool ?? step?.name ?? step?.summary ?? p.summary
      ?? data?.name ?? data?.toolName ?? data?.tool
    )
  })

/** 目录 basename（与 opencode.ts 同规则；不共享代码避免 dsh→opencode 交叉 import） */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

/** 工作区路径/项目名候选（📌 dsh 事件是否携带工作区路径未标定；拿到即 basename 浓缩） */
const pickProject = (args: readonly unknown[]): string | null => {
  const raw = scan(args, (p) => p.project ?? p.workspace ?? p.cwd ?? p.directory)
  if (!raw) return null
  const name = /[/\\]/.test(raw) ? basename(raw) : raw
  return name.length > 0 ? name.slice(0, 32) : null
}

export interface DshNormalizer {
  (channel: string, args: readonly unknown[]): InternalEvent[]
}

export interface DshNormalizerOptions {
  /** PB.33：turn 边界动态读取标题（dsh-entry 注入 ctx.sessionTitle.get()）——覆盖重启后
   *  旧会话（log-only `session/title` 不补发）。返回 null/抛错一律静默。 */
  resolveTitle?: (session: unknown) => string | null
}

/**
 * 归一化器工厂（闭包，非纯函数——打断兜底需要跨事件记忆）：
 * 内部维护「已见终态（完成/失败）」会话集合，agent/disposed 时判据其上（R2 Phase 1 形态）。
 * 纯函数版无法表达该依赖，故以工厂暴露（接口级偏差已在详细设计 §10.3 现状注记）。
 */
export function createDshNormalizer(opts: DshNormalizerOptions = {}): DshNormalizer {
  const ended = new Set<string>()
  /** PB.33：上次已知标题——turn 边界动态解析只在变化时补发 session.renamed */
  const lastTitle = new Map<string, string>()

  const resolveTitleEvents = (sid: string, session: unknown): InternalEvent[] => {
    if (!opts.resolveTitle) return []
    try {
      const title = opts.resolveTitle(session)
      if (!title || lastTitle.get(sid) === title) return []
      lastTitle.set(sid, title)
      return [{ type: 'session.renamed', sessionID: sid, title }]
    } catch {
      return [] // 铁律 1：宿主服务异常不影响主链
    }
  }

  return (channel, args) => {
    try {
      // 子 Agent 过滤（TC-DA3）：creator 非空一律不聚合
      if (pickCreator(args)) return []
      const sid = pickSessionID(args)
      if (!sid) return [] // 事件缺会话标识（畸形/未知形态）：静默忽略（TC-DA4）
      const project = pickProject(args)
      const withP = <T extends InternalEvent>(event: T): T | (T & { project: string }) =>
        project ? { ...event, project } : event

      switch (channel) {
        case 'session/created': {
          const title = pickTitle(args)
          if (title) lastTitle.set(sid, title)
          return [withP({ type: 'session.created', sessionID: sid, ...(title ? { title } : {}) })]
        }
        case 'session/event': {
          // 【PB.23 核心发现 2026-11-17】durable SessionEvent 唯一出口：
          // args = (session: Session, event: {seq,time,type,data})——turn/step 边界
          // "是 durable 事件而非 agent emits"（官方 core.md）；审批审计对（approval/asked|decided）
          // 亦为 log-only durable 事件。working/完成/心跳/审批的权威信号源全在此。
          const ev = asProps(args[1])
          const type = str(ev?.type)
          const data = asProps(ev?.data)
          switch (type) {
            case 'turn/start':
              // 每 turn 开始（用户提问→干活）——真 working 信号（agent/session-start 不随轮触发）
              // PB.33：先动态解析标题（重启后旧会话的 title 事件不会补发），再进 working
              return [
                ...resolveTitleEvents(sid, args[0]),
                withP({ type: 'session.started', sessionID: sid }),
              ]
            case 'turn/end': {
              // 每 turn 结束——完成权威信号 + 终态登记（disposed 兜底判据）
              const events = resolveTitleEvents(sid, args[0])
              ended.add(sid)
              events.push(withP({ type: 'session.completed', sessionID: sid }))
              return events
            }
            case 'step/start':
            case 'step/end':
            case 'tool/call':
            case 'tool/result': {
              // 工作活跃心跳（durable 流；live tools/result 双保险，重复心跳对 engine 无害）。
              // 工具失败 ≠ 会话失败（types.ts 失败两层哲学）
              const text = str(data?.name) ?? str(data?.toolName) ?? '执行中'
              return [withP({ type: 'tool.started', sessionID: sid, text: text.slice(0, 24) })]
            }
            case 'user/message':
              // 用户提交消息 = 用户在场（清完成队列；与 live inbox/claimed 双通道，engine 幂等）
              return [{ type: 'user.active', sessionID: sid, ...(project ? { project } : {}) }]
            case 'session/title': {
              // DSH 标题是 log-only `session/title`（data.title）；session/created 时通常还没有标题。
              // 映射为 session.renamed，让台账别名从 S 序号升级为真实页签名（含手动改名）。
              const title = str(data?.title)
              if (!title) return []
              lastTitle.set(sid, title)
              return [{ type: 'session.renamed', sessionID: sid, title }]
            }
            case 'approval/asked':
              // 审计对之一（log-only durable）——待批准灯效的正确来源
              return [withP({ type: 'permission.asked', sessionID: sid })]
            case 'approval/decided':
              // 审计对之二：allowed-once/rejected/cancelled/unavailable——对灯效均为"已决"
              return [withP({ type: 'permission.resolved', sessionID: sid })]
            default:
              // assistant/message、system/message、request/*、session/end-seed、
              // permission/preset、sandbox/mode、approval/policy 等：不映射
              return []
          }
        }
        case 'agent/session-start':
          // 会话生命周期建立（实测：boot 恢复会话不触发；每轮 turn 也不触发——working 主信号 = turn/start）
          return [withP({ type: 'session.started', sessionID: sid })]
        case 'agent/step':
        case 'tools/result': {
          // live 工作心跳（agent/step 实测未触发，保留订阅观察；tools/result 官方示例即用）
          const text = pickToolText(args) ?? '执行中'
          return [withP({ type: 'tool.started', sessionID: sid, text: text.slice(0, 24) })]
        }
        case 'agent/request-error':
        case 'agent/error':
          ended.add(sid) // 终态登记：之后 disposed 不再判打断（保红灯常驻到解决信号）
          return [withP({ type: 'session.failed', sessionID: sid })]
        case 'approval/request':
          // waterfall 答复者 seam（观察位，恒 next() 转发；主信号 = session/event 的 approval/asked。
          // 若分发到达，permission.asked 与审计重复——engine 幂等，重复置 waiting 无害）
          return [withP({ type: 'permission.asked', sessionID: sid })]
        case 'agent/disposed':
          // 打断兜底（R2 Phase 1，TC-DA9）：已见终态 → 正常收尾无事件；
          // 未见终态 → 判打断 abandoned（回默认，不进完成队列——completed 已删台账，
          // 失败后被 abandoned 会误清红灯，故完成/失败两类终态都必须登记）
          return ended.has(sid) ? [] : [withP({ type: 'session.abandoned', sessionID: sid })]
        case 'agent/inbox/claimed':
          // 用户输入被认领 = 用户在场（清完成队列 + error 视为已知晓）
          return [{ type: 'user.active', sessionID: sid, ...(project ? { project } : {}) }]
        default:
          return [] // 未订阅通道（理论不达）：静默
      }
    } catch {
      return [] // 铁律 1：任何畸形绝不外抛（TC-DA4 双保险——scan 层 + 此处兜底）
    }
  }
}

/** attach 需要的最小 ctx 形态（鸭子类型；真实 Cordis ctx.on 自带 Effect 自动清理） */
export interface DshEventCtx {
  /** 返回值：Cordis 返回 disposer 函数；mock 环境可返回任意值（detach 仍有标志位兜底）。
   *  listener 签名宿主边界放 any（waterfall 通道收 (payload, next)，emit 通道收任意参元组） */
  on: (name: string, cb: (...args: any[]) => any) => unknown
}

/**
 * 薄接线：订阅 12 通道 → 归一化 → emit（GlanceLoop.handleEvent）。
 * 返回 disposer：调用后不再派发（标志位）+ 逐个调用 ctx.on 返回的 disposer（若有）。
 * 真实 dsh 环境中插件卸载由 Cordis Effect 自动清理，disposer 主要服务测试与非 Cordis 环境。
 *
 * @param onRaw 可选原始事件观察口（先于归一化回调）：dsh-entry 用于面板留痕与
 *               logEvents JSONL dump——PB.23 标定的全量 payload 通道。
 */
export function attachDshEvents(
  ctx: DshEventCtx,
  emit: (e: InternalEvent) => void,
  onRaw?: (channel: string, args: readonly unknown[]) => void,
  opts?: DshNormalizerOptions,
): () => void {
  const normalize = createDshNormalizer(opts)
  const offs: unknown[] = []
  let detached = false

  const dispatch = (channel: string, args: readonly unknown[]): void => {
    if (detached) return
    try {
      try {
        onRaw?.(channel, args) // 观察口独立兜底：raw 留痕抛错绝不能断 emit 主链
      } catch {
        // 静默
      }
      for (const ie of normalize(channel, args)) emit(ie)
    } catch {
      // 铁律 1：emit（下游泵）异常不得外抛——尤其不许影响 approval 转发（见恒 next() 结构）
    }
  }

  for (const channel of DSH_CHANNELS) {
    try {
      if (channel === 'approval/request') {
        // 【恒 next() 纪律】（详细设计 §10.4，铁律 2 的 dsh 面落实，TC-DA2 锁死）：
        // 唯一 return 路径 = return next()——不答复、不改写、不短路。
        // 观察分支（dispatch）整体 try/catch 吞掉，任何异常都不改变转发行为。
        offs.push(
          ctx.on(channel, (req: unknown, next: () => unknown) => {
            dispatch(channel, [req]) // 注意：next 不进归一化（它不是 payload）
            return next()
          }),
        )
      } else {
        offs.push(
          ctx.on(channel, (...args: unknown[]) => {
            dispatch(channel, args)
          }),
        )
      }
    } catch {
      // 单通道注册失败（宿主版本差异等）：降级继续注册其余通道（铁律 1）
    }
  }

  return () => {
    detached = true
    for (const off of offs) {
      try {
        if (typeof off === 'function') (off as () => void)()
      } catch {
        // 静默
      }
    }
  }
}
