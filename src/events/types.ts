/**
 * InternalEvent —— 平台中立的内部事件模型（跨平台隔离纪律 D02）。
 * 宿主事件类型只许出现在 src/events/opencode.ts；本文件是全项目唯一事件定义点。
 * 语义定义（详细设计 §3.1）：completed = 本轮 run 结束；失败分两层，仅会话级异常终止触发 session.failed。
 */

export type InternalEvent =
  | { type: 'permission.asked'; sessionID: string; project?: string }
  | { type: 'permission.resolved'; sessionID: string; project?: string }
  | { type: 'tool.started'; sessionID: string; text: string; project?: string }
  /** 用户提交消息、本轮 run 开始（reasoning 前）——灯效立即进 working 的启动信号（v0.1.1/D13） */
  | { type: 'session.started'; sessionID: string; project?: string }
  | { type: 'session.completed'; sessionID: string; project?: string }
  | { type: 'session.failed'; sessionID: string; project?: string }
  /** run 被打断（用户/超时/被取代）：会话移除、回默认显示，不进完成队列（v0.1.1/D13） */
  | { type: 'session.abandoned'; sessionID: string; project?: string }
  /** 会话创建（v2 官方 session.created）：携带 title / parentID——标题来源 + 子会话识别 */
  | { type: 'session.created'; sessionID: string; title?: string; parentID?: string; project?: string }
  /** GUI 页签重命名（v2 官方 session.renamed）→ 台账 title 更新，别名显示重命名后的名字 */
  | { type: 'session.renamed'; sessionID: string; title: string }
  | { type: 'user.active'; sessionID?: string; project?: string }

export type InternalEventType = InternalEvent['type']
