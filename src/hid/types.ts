/**
 * HID 传输抽象与设备层日志接口。
 * node-hid 实现与 MockTransport 共同实现 HidTransport（注入式，CI 零硬件）。
 */

export interface HidTransport {
  /** 返回写入字节数；失败 reject（降级由设备层负责，绝不抛进宿主） */
  write(data: Uint8Array): Promise<number>
  /** 读一帧；超时返回 null；不得长时间阻塞事件循环（opencode server 进程内纪律） */
  read(timeoutMs: number): Promise<Uint8Array | null>
  close(): void
}

/** 设备层日志：默认静默实现，插件入口按选项注入可见实现 */
export interface DeviceLogger {
  warn(msg: string, err?: unknown): void
  debug(msg: string): void
}

export const SILENT_LOGGER: DeviceLogger = {
  warn() {},
  debug() {},
}
