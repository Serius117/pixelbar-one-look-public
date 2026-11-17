/**
 * MonitorHub —— 插件内建的本地网页监视器（用户提出的架构：monitor 是插件的镜像输出后端，
 * 不做独立进程、不找 server 端口——事件通道复用 ctx.event.subscribe，代码路径与真机完全统一）。
 *
 * - TeeDevice：结构兼容 PixelBarDevice 的分发代理——帧同时进 monitor 记录和真机 HID（真机不存在时仅记录）
 * - HTTP：127.0.0.1:18789（可配）；GET / 面板页面，GET /state JSON 快照（页面 500ms 轮询）
 * - noteRaw：记录原始事件的 type + location（事件 scope 实测：观察事件流是项目级还是全局级）
 * - 任何失败静默（铁律 1）：端口占用返回 false、渲染异常不影响输出
 */
import { createServer, type Server } from 'node:http'
import type { InternalEvent } from '../events/types.ts'
import type { PixelBarDevice } from '../hid/device.ts'
import { CMD, LIGHT } from '../hid/protocol.ts'

const LIGHT_NAMES: Record<number, string> = {
  [LIGHT.BREATHING]: '呼吸',
  [LIGHT.TIDE]: '潮汐',
  [LIGHT.SOLID]: '纯色',
  [LIGHT.RIPPLE]: '涟漪',
  [LIGHT.FLOW]: '流光逐影',
  [LIGHT.SHADOW]: '动态光影',
  [LIGHT.MASTER]: '总开关',
}

export interface LogEntry {
  t: number
  kind: 'event' | 'raw' | 'frame' | 'diag'
  line: string
}

const TEXT_WINDOW_MS = 10_000

export class MonitorHub {
  private log: LogEntry[] = []
  private lastText: { text: string; t: number } | null = null
  private lastEffect: { name: string; rgb: [number, number, number]; t: number } | null = null
  private server: Server | null = null
  private port = 0
  /** 引擎台账注入（控制台雏形 D14：会话状态摘要 + 完成队列） */
  private statsProvider: (() => unknown) | null = null
  /** 新实例接管端口时，旧实例收到的清理回调（宿主重载不调 cleanup 的兜底） */
  onShutdown: (() => void) | null = null

  setStatsProvider(fn: () => unknown): void {
    this.statsProvider = fn
  }

  /**
   * 绑定面板端口。若端口已被本插件的旧实例占用（宿主热重载不调用旧 cleanup），
   * 先通过 POST /shutdown 请求旧实例自灭并等待端口释放（接管）；
   * 旧实例若为无 /shutdown 的更早版本（接管失败），自动递增端口兜底（port..port+2）。
   */
  async start(port: number): Promise<boolean> {
    for (const candidate of [port, port + 1, port + 2]) {
      // 探测占用者是否为本插件旧 monitor（只认自家 /state 协议，不碰无关进程）
      let takenByOurs = false
      try {
        const res = await fetch(`http://127.0.0.1:${candidate}/state`, {
          signal: AbortSignal.timeout(500),
        })
        if (res.ok) {
          const snap = (await res.json()) as { monitorUrl?: unknown }
          if (typeof snap.monitorUrl === 'string') {
            takenByOurs = true
            try {
              await fetch(`http://127.0.0.1:${candidate}/shutdown`, {
                method: 'POST',
                signal: AbortSignal.timeout(500),
              })
            } catch {
              // 旧实例可能刚好退出：继续尝试绑定
            }
            // 等待端口释放（最多 2s）
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 100))
              try {
                await fetch(`http://127.0.0.1:${candidate}/state`, { signal: AbortSignal.timeout(200) })
              } catch {
                break // 已释放
              }
            }
          }
        }
      } catch {
        // 端口空闲：直接绑定
      }
      if (await this.tryBind(candidate)) {
        this.port = candidate
        return true
      }
      // 绑定仍失败：端口被不可接管的占用者占据（或旧版本实例无 /shutdown）→ 试下一个候选
      void takenByOurs
    }
    return false
  }

  private async tryBind(port: number): Promise<boolean> {
    if (this.server) return false
    let server: Server
    try {
      server = createServer((req, res) => {
        const url = req.url ?? '/'
        if (req.method === 'POST' && url.startsWith('/shutdown')) {
          // 新实例接管：关服务 + 通知清理（幂等）
          res.writeHead(200)
          res.end('ok')
          try {
            server.close()
          } catch {
            // 静默
          }
          this.server = null
          try {
            this.onShutdown?.()
          } catch {
            // 静默
          }
          return
        }
        if (url === '/' || url.startsWith('/index')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(PAGE)
        } else if (url.startsWith('/state')) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(this.snapshot()))
        } else {
          res.writeHead(404)
          res.end()
        }
      })
    } catch {
      return false
    }
    // 端口占用等失败是异步 error 事件：静默退出 monitor，绝不抛进宿主（铁律 1）
    server.on('error', () => {
      try {
        server.close()
      } catch {
        // 静默
      }
      this.server = null
    })
    this.server = server
    server.listen(port, '127.0.0.1')
    // 等待绑定结果（listening 或 error，最多 2s）
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      server.once('listening', done)
      server.once('error', done)
      setTimeout(done, 2_000)
    })
    if (this.server === server && server.listening) {
      return true
    }
    try {
      if (this.server === server) this.server = null
      server.close()
    } catch {
      // 静默
    }
    return false
  }

  isListening(): boolean {
    return this.server?.listening === true
  }

  stop(): void {
    try {
      this.server?.close()
    } catch {
      // 静默
    }
    this.server = null
  }

  /** 结构兼容 PixelBarDevice 的分发代理：帧写入真机（存在时）并记录到 monitor */
  teeDevice(real: PixelBarDevice | null): PixelBarDevice {
    const hub = this
    const dev = {
      get arrayIndex(): number {
        return real?.arrayIndex ?? 0x20
      },
      async sendFrame(cmd: number, payload: Uint8Array): Promise<void> {
        hub.recordFrame(cmd, payload)
        await real?.sendFrame(cmd, payload)
      },
      async sendFrameReliable(cmd: number, payload: Uint8Array): Promise<void> {
        hub.recordFrame(cmd, payload, '×3')
        await real?.sendFrameReliable(cmd, payload)
      },
      close(): void {
        real?.close()
      },
    }
    return dev as unknown as PixelBarDevice
  }

  /** 系统诊断行（插件加载/ctx 形态/stream 状态——实测校准通道） */
  pushDiag(msg: string): void {
    this.push({ t: Date.now(), kind: 'diag', line: msg })
  }

  /** InternalEvent 进事件日志 */
  noteEvent(ie: InternalEvent): void {
    const brief = JSON.stringify(ie)
    this.push({ t: Date.now(), kind: 'event', line: brief.length > 200 ? `${brief.slice(0, 200)}…` : brief })
  }

  /** 原始宿主事件观测：type + location（事件 scope 实测通道）；tool.called 附带完整 data（校准字段探取） */
  noteRaw(ev: unknown): void {
    const e = ev as { type?: unknown; location?: { directory?: unknown }; data?: unknown } | null
    if (!e || typeof e.type !== 'string') return
    const dir = typeof e.location?.directory === 'string' ? e.location.directory : ''
    let line = `${e.type}${dir ? ` @${dir}` : ''}`
    if (e.type === 'session.tool.called' || e.type === 'permission.asked' || e.type === 'form.created' || e.type === 'form.replied') {
      line += ` :: ${JSON.stringify(e.data ?? {}).slice(0, 400)}`
    }
    this.push({ t: Date.now(), kind: 'raw', line })
  }

  private recordFrame(cmd: number, payload: Uint8Array, suffix?: string): void {
    let line: string | null = null
    if (cmd === CMD.MOOD_SET) {
      const light = payload[1]
      const rgb: [number, number, number] = [payload[2], payload[3], payload[4]]
      const name = LIGHT_NAMES[light] ?? `灯区${light}`
      line = `灯效 ${name}(${rgb.join(',')},${payload[5]},${payload[6]})${suffix ?? ''}`
      this.lastEffect = { name, rgb, t: Date.now() }
    } else if (cmd === CMD.TEXT_SET) {
      const len = payload[1]
      const text = new TextDecoder().decode(payload.subarray(2, 2 + len))
      line = `文字 "${text}"`
      this.lastText = { text, t: Date.now() }
    } else if (cmd === CMD.PIXEL_SET) {
      const mode = payload[5] === 0x01 ? '时钟' : payload[6] === 0x01 ? '滚动' : '静态'
      line = `模式 ${mode}`
    } else if (cmd === CMD.MOOD_QUERY) {
      line = '查询 0x6A'
    }
    if (line) this.push({ t: Date.now(), kind: 'frame', line })
  }

  private push(entry: LogEntry): void {
    this.log.push(entry)
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200)
  }

  snapshot(): {
    now: number
    text: { display: string; fresh: boolean; ageMs: number } | null
    effect: { name: string; rgb: [number, number, number]; ageMs: number } | null
    monitorUrl: string
    stats: unknown
    log: LogEntry[]
  } {
    const now = Date.now()
    let stats: unknown = null
    try {
      stats = this.statsProvider?.() ?? null
    } catch {
      // 引擎摘要失败：控制台核心信息（灯效/文字/日志）不受影响
    }
    return {
      now,
      text: this.lastText
        ? {
            display: this.lastText.text,
            fresh: now - this.lastText.t < TEXT_WINDOW_MS,
            ageMs: now - this.lastText.t,
          }
        : null,
      effect: this.lastEffect ? { ...this.lastEffect, ageMs: now - this.lastEffect.t } : null,
      monitorUrl: `http://127.0.0.1:${this.port}`,
      stats,
      log: this.log.slice(-60),
    }
  }
}

// ---------- 面板页面（内嵌单文件，深色，500ms 轮询） ----------

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>pixelbar-one-look 虚拟 PixelBar</title>
<style>
  :root { color-scheme: dark; }
  body { background: #10141c; color: #dfe6f0; font-family: Consolas, "Microsoft YaHei", monospace; margin: 24px; }
  .bar { display: flex; align-items: center; gap: 20px; border: 1px solid #2a3244; border-radius: 14px; padding: 18px 22px; background: #151b26; }
  .glow { width: 46px; height: 46px; border-radius: 50%; transition: box-shadow .4s, background .4s; }
  .screen { font-size: 26px; letter-spacing: 2px; min-height: 34px; }
  .screen.idle { color: #5d6a80; }
  .meta { color: #7d8aa0; font-size: 12px; margin: 8px 2px; }
  .effect { color: #9fb4d8; }
  .log { margin-top: 18px; border-top: 1px solid #2a3244; padding-top: 10px; max-height: 42vh; overflow-y: auto; font-size: 12px; line-height: 1.7; }
  .log div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log .t { color: #55617a; margin-right: 8px; }
  .log .event { color: #8fd3a8; }
  .log .raw { color: #6f86ad; }
  .log .frame { color: #e0b35e; }
  .log .diag { color: #6ee2f5; }
  .pulse { animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
</style>
</head>
<body>
  <div class="bar">
    <div id="glow" class="glow"></div>
    <div id="screen" class="screen idle">（默认：时钟）</div>
  </div>
  <div class="meta" id="meta">连接中…</div>
  <div class="log" id="log"></div>
<script>
const fx = document.getElementById('glow'), sc = document.getElementById('screen'),
      meta = document.getElementById('meta'), lg = document.getElementById('log')
let lastLog = []
async function tick() {
  try {
    const s = await (await fetch('/state')).json()
    const eff = s.effect
    if (eff) {
      const c = eff.rgb.map(v => Math.max(40, v)).join(',')
      fx.style.background = 'rgb(' + c + ')'
      fx.style.boxShadow = '0 0 ' + (eff.name === '呼吸' ? 18 : 34) + 'px rgb(' + c + ')'
      fx.className = 'glow' + (eff.name === '呼吸' || eff.name === '流光逐影' || eff.name === '涟漪' ? ' pulse' : '')
    }
    if (s.text && s.text.fresh) { sc.textContent = s.text.display; sc.className = 'screen' }
    else { sc.textContent = '（默认：时钟' + (s.text ? '，静默 ' + Math.round(s.text.ageMs / 1000) + 's' : '') + '）'; sc.className = 'screen idle' }
    const st = s.stats || {}
    const parts = []
    if (st.working) parts.push('▶' + st.working + ' 执行')
    if (st.waiting) parts.push('⏸' + st.waiting + ' 待批')
    if (st.error) parts.push('✖' + st.error + ' 出错')
    if (!parts.length && !st.done) parts.push('空闲')
    if (st.done && st.done.length) parts.push('完成队列: ' + st.done.map(d => d.alias + ' (' + Math.round(d.ageMs / 60000) + '分钟)').join('、'))
    meta.innerHTML = '会话：' + parts.join(' · ')
      + ' · 灯效：' + (eff ? '<span class="effect">' + eff.name + '</span>（' + eff.ageMs + 'ms 前）' : '未点亮')
      + ' · <a href="' + s.monitorUrl + '" style="color:#7d8aa0">' + s.monitorUrl + '</a>'
    if (s.log.length !== lastLog.length || (s.log[0] && lastLog[0] && s.log[0].t !== lastLog[0].t)) {
      lastLog = s.log
      lg.innerHTML = s.log.map(e => {
        const time = new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })
        return '<div><span class="t">' + time + '</span><span class="' + e.kind + '">' + e.kind + '</span> ' + e.line + '</div>'
      }).join('')
    }
  } catch (e) { meta.textContent = '监视器未连接（插件未加载或已卸载）：' + e }
}
tick(); setInterval(tick, 500)
</script>
</body>
</html>`
