/**
 * opencode 宿主事件 → InternalEvent 归一化适配器（唯一允许接触宿主事件形态的文件，D02）。
 *
 * 【v2 实测定稿 2026-11-16】来源：@opencode/client 2.3.0 types.d.ts（官方类型）+ monitor 面板实测。
 * 【v0.1.1 修订（D13，用户真实使用反馈）】：
 *   - session.execution.started → session.started（消息提交即亮流光，不等第一个工具调用）
 *   - session.execution.interrupted → session.abandoned（打断回默认显示，不进完成队列）
 *   - working 态文字在调度层取消；工具调用仍产生 tool.started（维护最近活跃语义）
 *   - 别名=项目名：事件 location.directory 的 basename 填充 project 字段
 * 事件顶层形态：{ id, created, type, location?, data? }（data 字段，非 v1 草案的 properties）。
 * 防御原则：未知事件 / 字段缺失 → 返回空数组静默忽略（零 crash 铁律）；
 * 保留 v1 草案形态兼容（properties / message.part.updated / session.idle）。
 */
import type { InternalEvent } from './types.ts'

interface OpencodeEventLike {
  type?: unknown
  data?: unknown
  location?: unknown
  /** v1 草案形态兼容 */
  properties?: unknown
}

type Props = Record<string, any>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0
    ? v
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null

function pickSessionID(d: Props): string | null {
  return str(d.sessionID) ?? str(d.sessionId) ?? str(d.info?.sessionID) ?? str(d.part?.sessionID)
}

/** 事件 location → 项目名（目录 basename；别名与显示用，v0.1.1/D13） */
function pickProject(ev: OpencodeEventLike): string | undefined {
  const dir = (ev.location as { directory?: unknown } | undefined)?.directory
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  const clean = dir.replace(/[\\/]+$/, '')
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  const name = i >= 0 ? clean.slice(i + 1) : clean
  return name.length > 0 ? name : undefined
}

/** 文件路径 → basename（D08 规则式浓缩：`src/components/Login.tsx` → `Login.tsx`） */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * session.tool.called → 维护最近活跃语义（v0.1.1：working 态文字已取消，text 仅台账记录）。
 * input 内容摘要：command 前两词 / filePath basename / url hostname / pattern 截断。
 */
function toolCallText(d: Props): string {
  const input = (d.input ?? {}) as Props
  const command = str(input.command)
  if (command) return command.split(/\s+/).slice(0, 2).join(' ')
  const file = str(input.filePath) ?? str(input.file) ?? str(input.path)
  if (file) return /[/\\]/.test(file) ? basename(file) : file
  const url = str(input.url)
  if (url) {
    try {
      return new URL(url).hostname
    } catch {
      return url.slice(0, 20)
    }
  }
  const pattern = str(input.pattern) ?? str(input.query)
  if (pattern) return pattern.slice(0, 20)
  const id = str(d.id)
  return id && !id.startsWith('call_') ? id : '执行中'
}

export function normalizeOpencodeEvent(ev: unknown): InternalEvent[] {
  const e = ev as OpencodeEventLike | null
  if (!e || typeof e.type !== 'string') return []
  const d = (e.data ?? e.properties ?? {}) as Props
  const project = pickProject(e)
  const out: InternalEvent[] = []
  /** 构造 helper：附 project（若有）；T 约束 InternalEvent 保住字面量类型 */
  const withP = <T extends InternalEvent>(event: T): T | (T & { project: string }) =>
    project ? { ...event, project } : event

  switch (e.type) {
    // ---- 权限（v2 官方类型）----
    case 'permission.asked': {
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'permission.asked', sessionID: sid }))
      break
    }
    case 'permission.replied': {
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'permission.resolved', sessionID: sid }))
      break
    }
    // ---- 会话 run 生命周期（v2 官方类型：session.execution.*）----
    case 'session.execution.started': {
      // v0.1.1：消息提交即亮流光（不等第一个工具调用）
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'session.started', sessionID: sid }))
      break
    }
    case 'session.execution.succeeded': {
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'session.completed', sessionID: sid }))
      break
    }
    case 'session.execution.failed': {
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'session.failed', sessionID: sid }))
      break
    }
    case 'session.execution.interrupted': {
      // v0.1.1（D13 用户反馈）：打断（reason=user/shutdown/superseded/inactivity）→ 回默认显示，
      // 不进完成队列——用户手动打断时人就在屏幕前，庆祝/通知均无价值
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'session.abandoned', sessionID: sid }))
      break
    }
    case 'session.renamed': {
      // v0.1.1（R3 用户反馈）：GUI 页签重命名 → 台账 title（别名优先级最高，D13 已定）
      const sid = pickSessionID(d)
      const title = str(d.title)
      if (sid && title) out.push({ type: 'session.renamed', sessionID: sid, title })
      break
    }
    case 'session.created': {
      // v2 官方 session.created：title（自动标题）+ parentID（子会话识别：隐藏 title/compaction 会话不参与聚合）
      const sid = pickSessionID(d)
      if (!sid) break
      const title = str(d.title)
      const parentID = str(d.parentID)
      out.push(
        withP({
          type: 'session.created',
          sessionID: sid,
          ...(title ? { title } : {}),
          ...(parentID ? { parentID } : {}),
        }),
      )
      break
    }
    // ---- 工具调用（维护最近活跃；文字层已不显示，台账用）----
    case 'session.tool.called': {
      // 注意：called 事件发出时 executed 通常为 false（尚未执行完）——不据此过滤
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'tool.started', sessionID: sid, text: toolCallText(d) }))
      break
    }
    // ---- 用户活动（用户提交消息）----
    case 'session.inbox.enqueued': {
      const sid = pickSessionID(d)
      out.push({ type: 'user.active', sessionID: sid ?? undefined, project })
      break
    }

    case 'form.created': {
      // question 工具弹出选择界面（v0.1.4：与 permission.asked 同属"agent 等用户决策"）
      // 实测 data 结构：{ form: { id, sessionID, title, ... } }——sessionID 嵌套在 form 子对象里
      const sid = pickSessionID(d) ?? pickSessionID((d.form ?? {}) as Props)
      if (sid) out.push(withP({ type: 'permission.asked', sessionID: sid }))
      break
    }
    case 'form.replied': {
      // 用户完成选择/回答
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'permission.resolved', sessionID: sid }))
      break
    }

    // ---- v1 草案形态兼容（旧 opencode 版本）----
    case 'permission.updated': {
      const sid = pickSessionID(d)
      if (!sid) break
      const status = str(d.status) ?? str(d.state)
      if (status === 'pending' || status === 'requested' || status === 'asked') {
        out.push(withP({ type: 'permission.asked', sessionID: sid }))
      } else if (status === 'approved' || status === 'denied' || status === 'resolved') {
        out.push(withP({ type: 'permission.resolved', sessionID: sid }))
      }
      break
    }
    case 'message.part.updated': {
      const sid = pickSessionID(d)
      if (!sid) break
      const part = (d.part ?? d.data ?? {}) as Props
      if (part.type === 'tool') {
        out.push(withP({ type: 'tool.started', sessionID: sid, text: str(part.tool) ?? '?' }))
      } else if (part.type === 'error') {
        out.push(withP({ type: 'session.failed', sessionID: sid }))
      }
      break
    }
    case 'session.idle': {
      const sid = pickSessionID(d)
      if (sid) out.push(withP({ type: 'session.completed', sessionID: sid }))
      break
    }
    default:
      break // 其余事件（reasoning/text delta 等高频流）一律静默忽略
  }
  return out
}

// ---- v0.3 · 后台工作追踪（PB.31，2026-11-18）----
// 场景（用户实测）：agent 用 background:true 拉起脚本 → 轮次结束（execution.succeeded）
// 但脚本仍在后台跑 → 完成后通知 session（唤醒新回合）。此前灯效会在轮次结束就切"完成"——误导。
// 数据形态（持久化日志实证）：shell.created data={info:{id,status,command,metadata:{sessionID}}}；
//   shell.exited/deleted data={id}（只有 shell id，经 created 的映射配对归属会话）。
// 策略：succeeded 时若该会话仍有活跃 shell → 抑制 completed（引擎 working 态无时间衰减，
//   灯效自然保持流光）；最后一个 shell exited → 宽限期（防"涟漪→唤醒"闪烁）后 onLate 补发
//   completed；宽限期内 started/inbox 到达（宿主通知唤醒）→ 取消补发；interrupted → 撤销抑制。

export interface OpencodeNormalizerOptions {
  /** 排空后补发完成的宽限期；默认 3000ms */
  graceMs?: number
  /** 定时注入（测试用手动调度）；返回取消函数。默认 setTimeout */
  schedule?: (fire: () => void, ms: number) => () => void
  /** 宽限到点后延迟事件的出口（index.ts 接 monitor.noteEvent + loop.handleEvent） */
  onLate?: (events: InternalEvent[]) => void
}

export interface OpencodeNormalizer {
  (ev: unknown): InternalEvent[]
}

export function createOpencodeNormalizer(opts: OpencodeNormalizerOptions = {}): OpencodeNormalizer {
  const graceMs = opts.graceMs ?? 3000
  const schedule =
    opts.schedule ??
    ((fire: () => void, ms: number) => {
      const t = setTimeout(fire, ms)
      return () => clearTimeout(t)
    })

  /** 活跃 shell：shellId → sessionID（created 登记；exited/deleted 注销） */
  const liveShells = new Map<string, string>()
  /** 抑制完成的会话：sessionID → project（排空补发时保留别名兜底链） */
  const pendingDone = new Map<string, string | undefined>()
  /** 宽限计时器：sessionID → 取消函数 */
  const graceCancels = new Map<string, () => void>()

  const liveCount = (sid: string): number => {
    let n = 0
    for (const s of liveShells.values()) if (s === sid) n++
    return n
  }

  return (ev) => {
    try {
      const e = ev as OpencodeEventLike | null
      if (!e || typeof e.type !== 'string') return []
      const d = (e.data ?? e.properties ?? {}) as Props

      // ---- shell 生命周期登记（基础归一化不映射 shell 事件，本工厂独占）----
      if (e.type === 'shell.created') {
        const info = (d.info ?? {}) as Props
        const meta = (info.metadata ?? {}) as Props
        const id = str(info.id)
        const sid = str(meta.sessionID)
        if (id && sid) liveShells.set(id, sid)
        return []
      }
      if (e.type === 'shell.exited' || e.type === 'shell.deleted') {
        const id = str(d.id)
        if (id) {
          const sid = liveShells.get(id) ?? null // 先取归属，再注销
          liveShells.delete(id)
          // 最后一个后台 shell 排空 且 完成被抑制中 → 进宽限期（到点无人唤醒则补发完成）
          if (e.type === 'shell.exited' && sid && pendingDone.has(sid) && liveCount(sid) === 0) {
            scheduleDone(sid)
          }
        }
        return []
      }

      // ---- 基础事件路径的三个挂钩点 ----
      const sid = pickSessionID(d)
      if (e.type === 'session.execution.succeeded' && sid) {
        if (liveCount(sid) > 0) {
          // 轮次结束但后台 shell 仍在跑：抑制完成（灯效保持 working），登记待排空补发
          pendingDone.set(sid, pickProject(e))
          return []
        }
      }
      if (sid && (e.type === 'session.execution.started' || e.type === 'session.inbox.enqueued')) {
        // 宿主通知唤醒（后台脚本完成 → 通知 session → 新回合）：撤销抑制，正常走基础映射
        if (pendingDone.delete(sid)) graceCancels.get(sid)?.()
        graceCancels.delete(sid)
      }
      if (e.type === 'session.execution.interrupted' && sid) {
        // 打断撤销抑制：不庆祝不通知（D13）；后续 shell 排空也不再补发
        if (pendingDone.delete(sid)) graceCancels.get(sid)?.()
        graceCancels.delete(sid)
      }
      return normalizeOpencodeEvent(ev)
    } catch {
      return [] // 铁律 1：任何畸形绝不外抛
    }
  }

  function scheduleDone(sid: string): void {
    graceCancels.get(sid)?.() // 多 shell 交错退出时重开计时
    const project = pendingDone.get(sid)
    const cancel = schedule(() => {
      graceCancels.delete(sid)
      if (pendingDone.has(sid) && liveCount(sid) === 0) {
        pendingDone.delete(sid)
        opts.onLate?.([
          { type: 'session.completed', sessionID: sid, ...(project ? { project } : {}) },
        ])
      }
    }, graceMs)
    graceCancels.set(sid, cancel)
  }
}
