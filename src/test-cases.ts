/**
 * TC 用例库 —— 测试设计（docs/测试设计.md §4）的参数化实现。
 * 【v0.1.1 修订（D13）】working 态无文字（灯效表达）；别名=项目名；started 即亮流光；abandoned 回默认。
 * 时间轴注入 InternalEvent（L2 层）；宿主事件形态校准是 normalize 的独立测试（opencode.test.ts）。
 * 编号对照：TC-C1 静默断言并入 TC-A4；TC-A6 并入精确全等（无 solid 行）；TC-D4 序号兜底由 TC-A3 覆盖；
 * TC-E3/E4 留 PB.04 实测后补。
 */
import type { InternalEvent } from './events/types.ts'
import type { AggregationEngine } from './lights/states.ts'

const tool = (sessionID: string, text: string, project?: string): InternalEvent => ({
  type: 'tool.started', sessionID, text, project,
})
const started = (sessionID: string, project?: string): InternalEvent => ({
  type: 'session.started', sessionID, project,
})
const asked = (sessionID: string, project?: string): InternalEvent => ({
  type: 'permission.asked', sessionID, project,
})
const resolved = (sessionID: string): InternalEvent => ({ type: 'permission.resolved', sessionID })
const failed = (sessionID: string, project?: string): InternalEvent => ({
  type: 'session.failed', sessionID, project,
})
const completed = (sessionID: string, project?: string): InternalEvent => ({
  type: 'session.completed', sessionID, project,
})
const abandoned = (sessionID: string): InternalEvent => ({ type: 'session.abandoned', sessionID })
const active = (): InternalEvent => ({ type: 'user.active' })

export interface TimelineStep {
  atMs: number
  event: InternalEvent
}

export interface TimelineCase {
  title: string
  endMs: number
  timeline: TimelineStep[]
  setup?: (ctx: { engine: AggregationEngine }) => void
  noDevice?: boolean
  /** 期望语义行全等（decodeFrames 过滤 MOOD_QUERY 后比对） */
  expect?: string[]
  /** 期望语义行子序列包含（长轮播用例） */
  expectContains?: string[]
}

const IDLE = 'MOOD breathing(28,255,248,100,8)'
const FLOW = 'MOOD flow(1,0,0,100,255)'
const SHADOW = 'MOOD shadow(0,0,0,100,255)'
const SOLID_RED = 'MOOD solid(255,0,0,100,255)'
const RIPPLE = 'MOOD ripple(0,0,0,100,255)'
const ST = 'PIXEL static'
const SC = 'PIXEL scroll'
const CLK = 'PIXEL clock' // D16：窗口结束/text 熄灭时主动清屏（设备不会自动恢复）

export const CASES: Record<string, TimelineCase> = {
  'TC-A0': {
    title: 'D13：消息提交即亮流光（思考阶段不空窗）',
    endMs: 15_000,
    timeline: [{ atMs: 0, event: started('S1', 'pixelbar-bridge') }],
    expect: [IDLE, FLOW], // 灯效立即切流光；无文字帧
  },
  'TC-A1': {
    title: 'working 无文字（D13）：灯效切换 + 零 TEXT 帧；TC-C2：无 60s 重发',
    endMs: 70_000,
    timeline: [{ atMs: 0, event: tool('S1', 'Edit Login.tsx', 'pixelbar-bridge') }],
    expect: [IDLE, FLOW],
  },
  'TC-A3': {
    title: '完成庆祝：涟漪 5s → 呼吸；轮播文字=项目名（D13）；user.active 清队',
    endMs: 15_000,
    timeline: [
      { atMs: 0, event: tool('S1', 'Edit A.tsx', 'pixelbar-bridge') },
      { atMs: 2000, event: completed('S1', 'pixelbar-bridge') },
      { atMs: 9000, event: active() },
    ],
    expect: [
      IDLE, FLOW,
      RIPPLE, ST, 'TEXT "pixelbar-brid 完成"', // 13+1+2=16 字符，状态词完整（D13/D11 双线）
      IDLE, // @7s celebrating 结束涟漪转呼吸（text 相同不重发）
      CLK, // @9s user.active 清队 → idle 清屏（D16）
    ],
  },
  'TC-A4': {
    title: '等批准全流程：10s 窗口 → 清屏（D16）→ 60s 重复 → 解决浮出',
    endMs: 71_000,
    timeline: [
      { atMs: 0, event: asked('S1', 'pixelbar-bridge') },
      { atMs: 70_000, event: resolved('S1') },
    ],
    expect: [
      IDLE, SHADOW, ST, 'TEXT "pixelbar-bri 待批准"',
      CLK, // @10s 窗口结束 → 清屏
      ST, 'TEXT "pixelbar-bri 待批准"', // @60s 周期重开
      FLOW, // resolved → working 浮出（无文字，D13）
      CLK, // working 无文字 → 清掉上一窗口残留
    ],
  },
  'TC-A5': {
    title: '会话失败驻留：红灯持续到该会话新事件（D09 解决信号）',
    endMs: 70_000,
    timeline: [
      { atMs: 0, event: failed('S1', 'pixelbar-bridge') },
      { atMs: 65_000, event: tool('S1', 'Edit retry.ts', 'pixelbar-bridge') },
    ],
    expect: [
      IDLE, SOLID_RED, ST, 'TEXT "pixelbar-brid 出错"',
      CLK, // @10s 窗口结束 → 清屏；D18：error 不重复
      FLOW, // 新事件回落（无文字；窗口已清，无需再清屏）
    ],
  },
  'TC-A6': {
    title: '工具失败不触发红灯（无 session.failed 则保持 flow）',
    endMs: 15_000,
    timeline: [
      { atMs: 0, event: tool('S1', 'bash npm test', 'pixelbar-bridge') },
      { atMs: 3000, event: tool('S1', 'bash npm test') },
    ],
    expect: [IDLE, FLOW], // 无 solid 行 = 断言核心；无文字帧（D13）
  },
  'TC-A7': {
    title: 'D13：手动打断 → 回默认显示（不庆祝不通知）',
    endMs: 10_000,
    timeline: [
      { atMs: 0, event: started('S1', 'pixelbar-bridge') },
      { atMs: 2000, event: abandoned('S1') },
    ],
    expect: [IDLE, FLOW, IDLE], // started→流光；abandoned→呼吸（无 ripple 无 TEXT）
  },
  'TC-B1': {
    title: '3s 双会话 working：灯去重、无文字（最近活跃台账更新）',
    endMs: 15_000,
    timeline: [
      { atMs: 0, event: tool('S1', 'Edit A.tsx', 'proj-a') },
      { atMs: 2000, event: tool('S2', 'Edit B.tsx', 'proj-b') },
    ],
    expect: [IDLE, FLOW],
  },
  'TC-B2': {
    title: 'waiting 抢占 working；解决后 working 浮出（灯效无文字）',
    endMs: 71_000,
    timeline: [
      { atMs: 0, event: tool('S1', 'Edit A.tsx', 'proj-a') },
      { atMs: 2000, event: asked('S2', 'proj-b') },
      { atMs: 70_000, event: resolved('S2') },
    ],
    expect: [
      IDLE, FLOW,
      SHADOW, ST, 'TEXT "proj-b 待批准"',
      CLK, // @12s 窗口结束 → 清屏（D16）
      ST, 'TEXT "proj-b 待批准"', // @62s
      FLOW, // resolved → working 浮出
      CLK, // working 无文字 → 清屏
    ],
  },
  'TC-B3': {
    title: '双等待计数：N个待批准 → 单个回退',
    endMs: 71_000,
    timeline: [
      { atMs: 0, event: asked('S1', 'proj-a') },
      { atMs: 2000, event: asked('S2', 'proj-b') },
      { atMs: 70_000, event: resolved('S1') },
    ],
    expect: [
      IDLE, SHADOW, ST, 'TEXT "proj-a 待批准"',
      ST, 'TEXT "2个待批准"',
      CLK, // @12s 窗口结束 → 清屏（D16）
      ST, 'TEXT "2个待批准"', // @62s 周期重开
      ST, 'TEXT "proj-b 待批准"', // resolved 后 count=1（shadow 去重不重发）
      CLK, // 窗口结束（text 未变）→ 清屏
    ],
  },
  'TC-B4': {
    title: 'error 被 waiting 压制；解决后红灯浮出',
    endMs: 71_000,
    timeline: [
      { atMs: 0, event: failed('S1', 'proj-a') },
      { atMs: 2000, event: asked('S2', 'proj-b') },
      { atMs: 70_000, event: resolved('S2') },
    ],
    expect: [
      IDLE, SOLID_RED, ST, 'TEXT "proj-a 出错"',
      SHADOW, ST, 'TEXT "proj-b 待批准"',
      CLK, // @12s 窗口结束 → 清屏（D16）
      ST, 'TEXT "proj-b 待批准"', // @62s
      SOLID_RED, ST, 'TEXT "proj-a 出错"', // 浮出即开窗
    ],
  },
  'TC-B5': {
    title: 'done 不抢占 working；工作结束后 done 接管',
    endMs: 61_500,
    timeline: [
      { atMs: 0, event: tool('S1', 'Edit A.tsx', 'proj-a') },
      { atMs: 1000, event: tool('S2', 'Edit B.tsx', 'proj-b') },
      { atMs: 2000, event: completed('S1', 'proj-a') }, // S2 仍 working：零帧
      { atMs: 60_000, event: completed('S2', 'proj-b') },
    ],
    expect: [
      IDLE, FLOW,
      // @2s–60s：done 被 working 压制，无 done 帧
      RIPPLE, ST, 'TEXT "proj-a 完成"', // 轮播指针（绝对时间 idx 20%2=0 → 先播 proj-a）
      // @61s 窗口关闭静默（endMs 避开 63s 下一条轮播）
    ],
  },
  'TC-B6': {
    title: '离开归来：双完成轮播 → user.active 清队',
    endMs: 25_000,
    timeline: [
      { atMs: 0, event: completed('S1', 'proj-a') },
      { atMs: 1000, event: completed('S2', 'proj-b') },
      { atMs: 20_000, event: active() },
    ],
    expect: [
      IDLE, RIPPLE, ST, 'TEXT "proj-a 完成"',
      ST, 'TEXT "proj-b 完成"', // @3s 轮播槽
      IDLE, // @6s celebrating 结束
      ST, 'TEXT "proj-a 完成"', // @6s idx 0
      ST, 'TEXT "proj-b 完成"', // @9s idx 1
      // @20s user.active → idle（breathing 同帧去重，无新帧）+ 清屏（D16）
      CLK,
    ],
  },
  'TC-B7': {
    title: '三会话完成队列：首窗轮播后不再重复（D18）',
    endMs: 70_000,
    timeline: [
      { atMs: 0, event: completed('S1', 'proj-a') },
      { atMs: 1000, event: completed('S2', 'proj-b') },
      { atMs: 2000, event: completed('S3', 'proj-c') },
    ],
    expectContains: [
      'TEXT "proj-a 完成"', 'TEXT "proj-b 完成"', 'TEXT "proj-c 完成"', // 首窗轮播（10s 内）
      // D18：done 不 60s 重复——@70s 前无第二窗口
    ],
  },
  'TC-C3': {
    title: 'done 条目 10min 过期自动清（D18：只显示一次，不重复）',
    endMs: 661_000,
    timeline: [{ atMs: 0, event: completed('S1', 'proj-a') }],
    expect: [
      IDLE, RIPPLE, ST, 'TEXT "proj-a 完成"',
      IDLE, // @5s celebrating 结束
      CLK, // @10s 窗口结束 → 清屏；D18：done 不再 60s 重复
      // @600s 条目 TTL 过期 → 聚合已 idle（呼吸同帧去重，无新帧）
    ],
  },
  'TC-D2': {
    title: '超长项目名：compose 双预算截断至 ≤16 字符静态显示（D13/D11，状态词完整）',
    endMs: 15_000,
    timeline: [{ atMs: 0, event: completed('S1', 'a-very-long-project-name') }],
    expect: [
      IDLE, RIPPLE,
      ST, 'TEXT "a-very-long-p 完成"', // 25 字符项目名截 13，+完成=16 恰好（不再触发滚动）
      IDLE, // @5s 涟漪转呼吸
      CLK, // @10s 窗口结束 → 清屏（D16）
    ],
  },
  'TC-D3': {
    title: '超长项目名字节截断：状态词"完成"完整保留（D08 拼接后整体预算）',
    endMs: 5_000,
    timeline: [{ atMs: 0, event: completed('S1', '这是一个特别特别长的会话标题需要字节截断处理才能显示') },
    ],
    expect: [
      IDLE, RIPPLE, ST,
      'TEXT "这是一个特别特别长的会话标 完成"', // 别名截预算，"完成"完整
      IDLE, // @5s 涟漪转呼吸
    ],
  },
  'TC-D5': {
    title: '项目名正常拼接（≤16 字符直接显示）',
    endMs: 5_000,
    timeline: [{ atMs: 0, event: completed('S1', 'demo-app') }],
    expect: [IDLE, RIPPLE, ST, 'TEXT "demo-app 完成"', IDLE],
  },
  'TC-E1': {
    title: '全程无设备：事件处理零 crash、零帧输出（查询帧过滤后）',
    endMs: 10_000,
    timeline: [
      { atMs: 0, event: tool('S1', 'Edit A.tsx', 'proj-a') },
      { atMs: 1000, event: completed('S1', 'proj-a') },
    ],
    noDevice: true,
    expect: [],
  },
}
