/**
 * AggregationEngine —— 多会话聚合状态机（纯逻辑，零宿主依赖，D02）。
 *
 * 规格（灯效映射.md + DECISIONS D09）：
 * - 优先级压缩：waiting > error > working > done 队列非空 > idle；同级取最近活跃
 * - 压制与浮出：驻留 = 在候选集合保持；显示被更高优先级压制，解除后浮出即开窗
 * - error 解决信号：该会话新事件 或 user.active（D09 拍板）；工具级失败不进 error
 * - 文字组装在本层完成（D08），调度器拿现成的：状态词永远完整，别名按 48B 预算截断
 * - done 轮播指针 = 绝对时间推导（floor(now/3s) % len），天然跨窗口保持（TC-B7）
 * - nextDeadline 暴露聚合层时序：轮播切换 / 条目过期 / 涟漪 5s 转呼吸
 */
import type { InternalEvent } from '../events/types.ts'
import { TEXT_MAX_BYTES } from '../hid/protocol.ts'

export const DONE_RIPPLE_MS = 5_000
export const DONE_ENTRY_TTL_MS = 10 * 60_000
export const DONE_ROTATE_MS = 3_000
/** 标题缓存上限（PB.33）：标题独立于会话台账存活，防止长期运行无限增长 */
const TITLE_CACHE_LIMIT = 512

export interface DoneEntry {
  sessionID: string
  alias: string
  ts: number
}

export type Aggregate =
  | { kind: 'idle' }
  | { kind: 'working'; text: string }
  | { kind: 'waiting'; count: number; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; text: string; remaining: number; celebrating: boolean }

interface SessionRecord {
  id: string
  seq: number
  title: string | null
  /** 项目名（location 目录 basename，D13 别名基准） */
  project: string | null
  /** 子会话（title/compaction 等隐藏会话）：不参与聚合，防幽灵「完成」通知 */
  parentID: string | null
  status: 'working' | 'waiting' | 'error' | 'idle'
  lastActiveTs: number
  lastToolText: string | null
}

// ---------- 文字组装（D08：状态词永远完整；别名按字节预算截断） ----------

const utf8Len = (s: string): number => new TextEncoder().encode(s).length

function truncateBytes(s: string, maxBytes: number): string {
  if (utf8Len(s) <= maxBytes) return s
  let out = ''
  for (const ch of [...s]) {
    if (utf8Len(out + ch) > maxBytes) break
    out += ch
  }
  return out
}

/** 拼接 `别名 状态词`：状态词永远完整（D13/D11 双线硬保证）——
 *  PB.34b：不再按 16 字符截别名（那是全角近似）；只保 48B 硬上限，
 *  宽度超 256px 由调度层走 0xEF 滚动，不在这里截断。 */
function compose(alias: string, stateWord: string): string {
  const wordBytes = utf8Len(stateWord)
  const byteBudget = TEXT_MAX_BYTES - wordBytes - 1
  if (byteBudget <= 0) return truncateBytes(stateWord, TEXT_MAX_BYTES)
  const trimmed = truncateBytes(alias, byteBudget)
  return `${trimmed} ${stateWord}`
}

// ---------- 引擎 ----------

export class AggregationEngine {
  private sessions = new Map<string, SessionRecord>()
  private nextSeq = 1
  private doneQueue: DoneEntry[] = []
  private lastDoneTs: number | null = null
  /** 标题独立缓存（PB.33）：session.completed 会删台账，标题不能跟着丢——
   *  否则手动改名/自动标题在下一轮 turn 重建台账后退化 S 序号 */
  private titles = new Map<string, string>()

  /** 会话别名（D13）：title（会话名，v0.2 接线）→ 项目名 → S 序号兜底 */
  alias(id: string): string {
    const remembered = this.titles.get(id)
    if (remembered) return remembered
    const r = this.sessions.get(id)
    if (r?.title) return r.title
    if (r?.project) return r.project
    if (r) return `S${r.seq}`
    return id
  }

  /** 标题入独立缓存（LRU 式：重复写入移到末尾，超限淘汰最旧） */
  private rememberTitle(id: string, title: string): void {
    if (!title) return
    this.titles.delete(id)
    this.titles.set(id, title)
    if (this.titles.size > TITLE_CACHE_LIMIT) {
      const oldest = this.titles.keys().next().value
      if (oldest !== undefined) this.titles.delete(oldest)
    }
  }

  /** 入口层发现会话标题时注入（事件携带或 session.list 兜底，PB.04 接线）；会话未建时预置 */
  setSessionTitle(id: string, title: string): void {
    this.rememberTitle(id, title)
    const r = this.ensure(id, 0)
    r.title = title
  }

  /** 入口层冷启动播种（session.list）：title / parentID / project 一次落账（子会话判定依据） */
  registerSession(info: {
    id: string
    title?: string | null
    parentID?: string | null
    project?: string | null
  }): void {
    const r = this.ensure(info.id, 0)
    if (info.title) {
      this.rememberTitle(info.id, info.title)
      r.title = info.title
    }
    if (info.parentID !== undefined) r.parentID = info.parentID ?? null
    if (info.project) r.project = info.project
  }

  /** 子会话（隐藏 title/compaction 等）不参与聚合——避免幽灵完成/抢占 */
  private isChild(id: string): boolean {
    return this.sessions.get(id)?.parentID != null
  }

  private ensure(id: string, now: number): SessionRecord {
    let r = this.sessions.get(id)
    if (!r) {
      r = {
        id,
        seq: this.nextSeq++,
        title: this.titles.get(id) ?? null,
        project: null,
        parentID: null,
        status: 'idle',
        lastActiveTs: now,
        lastToolText: null,
      }
      this.sessions.set(id, r)
    }
    return r
  }

  apply(event: InternalEvent, now: number): void {
    const project = 'project' in event ? event.project : undefined
    const remember = (r: SessionRecord): void => {
      if (project) r.project = project
    }
    // 子会话隔离：执行/权限/完成等事件一律不聚合（title/compaction 等隐藏会话会产生幽灵通知）
    if (
      event.type !== 'session.created' &&
      event.type !== 'session.renamed' &&
      event.type !== 'user.active' &&
      this.isChild(event.sessionID)
    ) {
      return
    }
    switch (event.type) {
      case 'session.created': {
        // v2：自动标题到达 + 子会话标记（session.list 播种的补充）
        const r = this.ensure(event.sessionID, now)
        remember(r)
        if (event.title) {
          this.rememberTitle(event.sessionID, event.title)
          r.title = event.title
        }
        if (event.parentID !== undefined) r.parentID = event.parentID
        break
      }
      case 'session.started': {
        // D13：消息提交即进 working（思考阶段灯效不空窗）
        const r = this.ensure(event.sessionID, now)
        remember(r)
        r.status = 'working'
        r.lastActiveTs = now
        break
      }
      case 'permission.asked': {
        const r = this.ensure(event.sessionID, now)
        remember(r)
        r.status = 'waiting'
        r.lastActiveTs = now
        break
      }
      case 'permission.resolved': {
        const r = this.sessions.get(event.sessionID)
        // waiting 解决 → working（批准后 agent 继续跑；若实际停了 session.idle 会很快到）
        if (r && r.status === 'waiting') {
          r.status = 'working'
          r.lastActiveTs = now
        }
        break
      }
      case 'tool.started': {
        const r = this.ensure(event.sessionID, now)
        remember(r)
        r.status = 'working'
        r.lastToolText = event.text
        r.lastActiveTs = now
        break
      }
      case 'session.failed': {
        const r = this.ensure(event.sessionID, now)
        remember(r)
        r.status = 'error'
        r.lastActiveTs = now
        break
      }
      case 'session.completed': {
        const r = this.ensure(event.sessionID, now)
        remember(r)
        // 别名优先级 title→project→S 序号（R3 落地）：完成轮播也用同一别名，不再强制项目名
        const alias = this.alias(event.sessionID)
        this.doneQueue.push({ sessionID: event.sessionID, alias, ts: now })
        this.lastDoneTs = now
        this.sessions.delete(event.sessionID)
        break
      }
      case 'session.abandoned': {
        // D13：打断（用户/超时/被取代）→ 会话移除回默认，不进完成队列
        this.sessions.delete(event.sessionID)
        break
      }
      case 'session.renamed': {
        // R3：GUI 页签重命名 → 台账 title（不动状态）；别名优先级 title→project→S（D13）
        // PB.33：标题写入独立缓存——完成删台账后/下一轮重建台账时仍能取到，不再退 S 序号。
        // 标题可能晚于 turn/end 到达：完成条目已入队时同步回写别名，避免锁死 S 序号。
        this.rememberTitle(event.sessionID, event.title)
        const r = this.sessions.get(event.sessionID)
        if (r) r.title = event.title
        for (const entry of this.doneQueue) {
          if (entry.sessionID === event.sessionID) entry.alias = event.title
        }
        break
      }
      case 'user.active': {
        // 用户已在看 opencode：完成队列清空；error 全部视为已知晓（D09 解决信号之一）
        this.doneQueue = []
        for (const r of this.sessions.values()) {
          if (r.status === 'error') r.status = 'idle'
        }
        break
      }
    }
  }

  /** 纯读 + 绝对时间指针推导（幂等，可反复调用） */
  aggregate(now: number): Aggregate {
    const recent = (a: SessionRecord, b: SessionRecord): number => b.lastActiveTs - a.lastActiveTs
    const values = [...this.sessions.values()]

    const waiting = values.filter((r) => r.status === 'waiting').sort(recent)
    if (waiting.length > 0) {
      const text =
        waiting.length > 1
          ? `${waiting.length}个待批准`
          : compose(this.alias(waiting[0].id), '待批准')
      return { kind: 'waiting', count: waiting.length, text }
    }

    const errors = values.filter((r) => r.status === 'error').sort(recent)
    if (errors.length > 0) {
      return { kind: 'error', text: compose(this.alias(errors[0].id), '出错') }
    }

    const working = values.filter((r) => r.status === 'working').sort(recent)
    if (working.length > 0) {
      return { kind: 'working', text: working[0].lastToolText ?? '执行中' }
    }

    const entries = this.doneQueue.filter((e) => now - e.ts < DONE_ENTRY_TTL_MS)
    this.doneQueue = entries // 惰性清理过期条目
    if (entries.length > 0) {
      const index = Math.floor(now / DONE_ROTATE_MS) % entries.length
      const celebrating = this.lastDoneTs !== null && now - this.lastDoneTs < DONE_RIPPLE_MS
      return {
        kind: 'done',
        text: compose(entries[index].alias, '完成'),
        remaining: entries.length,
        celebrating,
      }
    }

    return { kind: 'idle' }
  }

  /** 聚合层"无事件也需重算"的时刻（轮播切换 / 条目过期 / 涟漪转呼吸） */

  /** 控制台雏形（D14）：引擎台账摘要——会话状态计数 + 完成队列条目 */
  stats(): { working: number; waiting: number; error: number; done: Array<{ alias: string; ageMs: number }> } {
    const values = [...this.sessions.values()]
    const now = Date.now()
    return {
      working: values.filter((r) => r.status === 'working').length,
      waiting: values.filter((r) => r.status === 'waiting').length,
      error: values.filter((r) => r.status === 'error').length,
      done: this.doneQueue.map((e) => ({ alias: e.alias, ageMs: now - e.ts })),
    }
  }

  nextDeadline(now: number): number | null {
    const entries = this.doneQueue.filter((e) => now - e.ts < DONE_ENTRY_TTL_MS)
    const list: number[] = []
    if (entries.length > 0) {
      list.push((Math.floor(now / DONE_ROTATE_MS) + 1) * DONE_ROTATE_MS) // 下一轮播槽
      const oldest = Math.min(...entries.map((e) => e.ts)) + DONE_ENTRY_TTL_MS
      if (oldest > now) list.push(oldest)
      if (this.lastDoneTs !== null && now - this.lastDoneTs < DONE_RIPPLE_MS) {
        list.push(this.lastDoneTs + DONE_RIPPLE_MS) // 涟漪 → 呼吸切换
      }
    }
    const next = list.filter((t) => t > now).sort((a, b) => a - b)[0]
    return next ?? null
  }
}
