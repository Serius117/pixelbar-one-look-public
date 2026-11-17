/**
 * 真实 node-hid 形状冒烟（非 CI 必需——node-hid 未安装时 skip，CI 零硬件铁律不破）。
 * 价值：鸭子假设 vs 实际库形状的锁定——v3 顶层 devices() + HID 构造器（2026-11-16 本机实证）。
 */
import { describe, expect, it } from 'vitest'
import { loadNodeHid } from './device.ts'
import { SILENT_LOGGER } from './types.ts'

describe('node-hid v3 形状（真机传输层冒烟，未安装则 skip）', () => {
  it('加载后形状：顶层 devices() 函数 + HID 构造器', async () => {
    const mod = await loadNodeHid(SILENT_LOGGER)
    if (!mod) {
      console.log('skip: node-hid 未安装（CI 环境）')
      return
    }
    expect(typeof mod.devices).toBe('function')
    expect(typeof mod.HID).toBe('function')
    const devices = mod.devices()
    expect(Array.isArray(devices)).toBe(true)
    console.log(`node-hid 枚举正常：${devices.length} 个 HID 设备`)
  })
})
