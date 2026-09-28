import { dlopen, FFIType, JSCallback, ptr, type Pointer } from 'bun:ffi'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconPath from '../../assets/TrayIcon.ico' with { type: 'file' }
import { logger } from '../log.ts'
import type { TrayEntry } from './tray.ts'

const log = logger('tray')

const WM_APP_TRAY = 0x8001
const WM_LBUTTONDBLCLK = 0x0203
const WM_LBUTTONUP = 0x0202
const WM_RBUTTONUP = 0x0205
const NIM_ADD = 0
const NIM_MODIFY = 1
const NIM_DELETE = 2
const NIF_MESSAGE = 0x1
const NIF_ICON = 0x2
const NIF_TIP = 0x4
const MF_STRING = 0x0
const MF_GRAYED = 0x1
const MF_SEPARATOR = 0x800
const TPM_RIGHTBUTTON = 0x2
const TPM_NONOTIFY = 0x80
const TPM_RETURNCMD = 0x100
const HWND_MESSAGE = -3
const PM_REMOVE = 1
const IMAGE_ICON = 1
const LR_LOADFROMFILE = 0x10
const LR_DEFAULTSIZE = 0x40

/** NOTIFYICONDATAW on 64-bit Windows (x64 and arm64 share the LLP64 layout). */
const NID_SIZE = 976

const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le')

/**
 * The Windows notification-area icon through Win32 via bun:ffi: a message-only window receives
 * the icon's mouse messages, and messages are pumped from a timer on the JS thread.
 */
export function startWindowsTray(menu: () => TrayEntry[], title: () => string, openDashboard: () => void): void {
  const user32 = dlopen('user32.dll', {
    RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
    CreateWindowExW: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    DefWindowProcW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
    PeekMessageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.bool },
    TranslateMessage: { args: [FFIType.ptr], returns: FFIType.bool },
    DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.i64 },
    CreatePopupMenu: { args: [], returns: FFIType.ptr },
    AppendMenuW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    TrackPopupMenu: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    DestroyMenu: { args: [FFIType.ptr], returns: FFIType.bool },
    SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
    PostMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.bool },
    LoadImageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    RegisterWindowMessageW: { args: [FFIType.ptr], returns: FFIType.u32 },
  })
  const shell32 = dlopen('shell32.dll', { Shell_NotifyIconW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.bool } })
  const kernel32 = dlopen('kernel32.dll', { GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr } })
  const u = user32.symbols

  const instance = kernel32.symbols.GetModuleHandleW(null)
  const taskbarCreated = u.RegisterWindowMessageW(ptr(wide('TaskbarCreated')))
  let hwnd: Pointer | null = null
  let actions: (() => void)[] = []

  const showMenu = () => {
    const popup = u.CreatePopupMenu()
    if (!popup || !hwnd) return
    actions = []
    for (const entry of menu()) {
      if (entry.kind === 'separator') u.AppendMenuW(popup, MF_SEPARATOR, 0, null)
      else if (entry.kind === 'label') u.AppendMenuW(popup, MF_STRING | MF_GRAYED, 0, ptr(wide(entry.text)))
      else {
        actions.push(entry.run)
        u.AppendMenuW(popup, MF_STRING, actions.length, ptr(wide(entry.text)))
      }
    }
    const point = new Int32Array(2)
    u.GetCursorPos(ptr(point))
    // Without this the menu doesn't close when the user clicks elsewhere.
    u.SetForegroundWindow(hwnd)
    const chosen = u.TrackPopupMenu(popup, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, point[0]!, point[1]!, 0, hwnd, null)
    u.PostMessageW(hwnd, 0, 0, 0)
    u.DestroyMenu(popup)
    if (chosen > 0) {
      try {
        actions[chosen - 1]?.()
      } catch (error) {
        log.error('Tray action failed', error)
      }
    }
  }

  const windowProc = new JSCallback((window: Pointer, message: number, wParam: bigint, lParam: bigint): bigint => {
    if (message === WM_APP_TRAY) {
      const event = Number(lParam & 0xffffn)
      if (event === WM_RBUTTONUP || event === WM_LBUTTONUP) showMenu()
      else if (event === WM_LBUTTONDBLCLK) openDashboard()
      return 0n
    }
    // Explorer restarted: the icon is gone and must be added again.
    if (message === taskbarCreated) addIcon()
    return BigInt(u.DefWindowProcW(window, message, wParam, lParam))
  }, { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 })

  const className = wide('MediaDownloaderTray')
  const windowClass = Buffer.alloc(80)
  windowClass.writeUInt32LE(80, 0)
  windowClass.writeBigUInt64LE(BigInt(windowProc.ptr!), 8)
  windowClass.writeBigUInt64LE(BigInt(instance ?? 0), 24)
  windowClass.writeBigUInt64LE(BigInt(ptr(className)), 64)
  if (!u.RegisterClassExW(ptr(windowClass))) throw new Error('RegisterClassExW failed')
  hwnd = u.CreateWindowExW(0, ptr(className), ptr(wide('MediaDownloader')), 0, 0, 0, 0, 0, HWND_MESSAGE, null, instance, null) as Pointer | null
  if (!hwnd) throw new Error('CreateWindowExW failed')

  // LoadImageW needs a real file; the embedded icon lives inside the executable.
  const iconFile = join(tmpdir(), 'mediadownloader-tray.ico')
  writeFileSync(iconFile, readFileSync(iconPath))
  const icon = u.LoadImageW(null, ptr(wide(iconFile)), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)

  const iconData = Buffer.alloc(NID_SIZE)
  iconData.writeUInt32LE(NID_SIZE, 0)
  iconData.writeBigUInt64LE(BigInt(hwnd), 8)
  iconData.writeUInt32LE(1, 16)
  iconData.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20)
  iconData.writeUInt32LE(WM_APP_TRAY, 24)
  iconData.writeBigUInt64LE(BigInt(icon ?? 0), 32)
  const setTip = (text: string) => {
    iconData.fill(0, 40, 40 + 256)
    iconData.write(text.slice(0, 127), 40, 'utf16le')
  }
  function addIcon() {
    setTip('MediaDownloader')
    shell32.symbols.Shell_NotifyIconW(NIM_ADD, ptr(iconData))
  }
  addIcon()

  let lastTip = ''
  setInterval(() => {
    const speed = title()
    const tip = speed ? `MediaDownloader — ↓ ${speed}` : 'MediaDownloader'
    if (tip === lastTip) return
    lastTip = tip
    setTip(tip)
    shell32.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(iconData))
  }, 2000)

  const message = Buffer.alloc(48)
  setInterval(() => {
    for (let i = 0; i < 64 && u.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE); i++) {
      u.TranslateMessage(ptr(message))
      u.DispatchMessageW(ptr(message))
    }
  }, 30)

  process.on('exit', () => shell32.symbols.Shell_NotifyIconW(NIM_DELETE, ptr(iconData)))
  log.info('Notification-area icon ready')
}
