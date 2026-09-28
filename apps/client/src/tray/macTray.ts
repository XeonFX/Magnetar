import { CFunction, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import iconPath from '../../assets/MenuBarIcon@2x.png' with { type: 'file' }
import { logger } from '../log.ts'
import type { TrayEntry } from './tray.ts'

const log = logger('tray')

/**
 * The macOS menu-bar item, driven through the Objective-C runtime with bun:ffi — no helper
 * binary. AppKit wants the main thread, which is the JS thread here, so events are pumped from a
 * timer instead of blocking in -[NSApplication run].
 */
export function startMacTray(menu: () => TrayEntry[], title: () => string): void {
  const objc = dlopen('/usr/lib/libobjc.A.dylib', {
    objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
    sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    objc_allocateClassPair: { args: [FFIType.ptr, FFIType.cstring, FFIType.u64], returns: FFIType.ptr },
    objc_registerClassPair: { args: [FFIType.ptr], returns: FFIType.void },
    class_addMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.bool },
  })
  // Loading AppKit registers its classes with the runtime.
  dlopen('/System/Library/Frameworks/AppKit.framework/AppKit', { NSApplicationLoad: { args: [], returns: FFIType.bool } })
  const libSystem = dlopen('/usr/lib/libSystem.B.dylib', { dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr } })
  const RTLD_DEFAULT = -2 as unknown as Pointer
  const msgSendPointer = libSystem.symbols.dlsym(RTLD_DEFAULT, cstr('objc_msgSend'))
  if (!msgSendPointer) throw new Error('objc_msgSend not found')
  const msgSend = msgSendPointer as Pointer

  // objc_msgSend is untyped: one CFunction per signature we call it with.
  const signatures = new Map<string, (...args: unknown[]) => unknown>()
  const send = (returns: FFIType, types: FFIType[], ...args: unknown[]): unknown => {
    const key = `${returns}:${types.join(',')}`
    let fn = signatures.get(key)
    if (!fn) {
      fn = CFunction({ ptr: msgSend, args: [FFIType.ptr, FFIType.ptr, ...types], returns }) as unknown as (...args: unknown[]) => unknown
      signatures.set(key, fn)
    }
    return fn(...args)
  }
  const selectors = new Map<string, Pointer>()
  const sel = (name: string) => {
    let s = selectors.get(name)
    if (!s) selectors.set(name, (s = objc.symbols.sel_registerName(cstr(name)) as Pointer))
    return s
  }
  const cls = (name: string) => objc.symbols.objc_getClass(cstr(name)) as Pointer
  const msg = (target: Pointer, selector: string) => send(FFIType.ptr, [], target, sel(selector)) as Pointer
  const msgPtr = (target: Pointer, selector: string, arg: Pointer | null) => send(FFIType.ptr, [FFIType.ptr], target, sel(selector), arg) as Pointer
  const nsString = (text: string) => send(FFIType.ptr, [FFIType.cstring], cls('NSString'), sel('stringWithUTF8String:'), cstr(text)) as Pointer

  const app = msg(cls('NSApplication'), 'sharedApplication')
  send(FFIType.bool, [FFIType.i64], app, sel('setActivationPolicy:'), 1) // accessory: no Dock icon
  send(FFIType.void, [], app, sel('finishLaunching'))

  let actions: (() => void)[] = []
  const nsMenu = msg(msg(cls('NSMenu'), 'alloc'), 'init')
  send(FFIType.void, [FFIType.bool], nsMenu, sel('setAutoenablesItems:'), false)

  const rebuild = () => {
    send(FFIType.void, [], nsMenu, sel('removeAllItems'))
    actions = []
    for (const entry of menu()) {
      if (entry.kind === 'separator') {
        msgPtr(nsMenu, 'addItem:', msg(cls('NSMenuItem'), 'separatorItem'))
        continue
      }
      const item = send(FFIType.ptr, [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        msg(cls('NSMenuItem'), 'alloc'), sel('initWithTitle:action:keyEquivalent:'),
        nsString(entry.text), entry.kind === 'command' ? sel('onItem:') : null, nsString('')) as Pointer
      if (entry.kind === 'command') {
        send(FFIType.void, [FFIType.ptr], item, sel('setTarget:'), target)
        send(FFIType.void, [FFIType.i64], item, sel('setTag:'), actions.length)
        actions.push(entry.run)
      } else {
        send(FFIType.void, [FFIType.bool], item, sel('setEnabled:'), false)
      }
      msgPtr(nsMenu, 'addItem:', item)
      msg(item, 'release')
    }
  }

  // A tiny Objective-C class whose methods call back into JS: menu actions and the
  // menu-will-open hook that rebuilds the rows from live state.
  const onItem = new JSCallback((_self: Pointer, _cmd: Pointer, sender: Pointer) => {
    const index = Number(send(FFIType.i64, [], sender, sel('tag')))
    try {
      actions[index]?.()
    } catch (error) {
      log.error('Tray action failed', error)
    }
  }, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void })
  const menuNeedsUpdate = new JSCallback(() => {
    try {
      rebuild()
    } catch (error) {
      log.error('Could not rebuild the tray menu', error)
    }
  }, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void })
  const targetClass = objc.symbols.objc_allocateClassPair(cls('NSObject'), cstr('MDTrayTarget'), 0) as Pointer
  objc.symbols.class_addMethod(targetClass, sel('onItem:'), onItem.ptr as Pointer, cstr('v@:@'))
  objc.symbols.class_addMethod(targetClass, sel('menuNeedsUpdate:'), menuNeedsUpdate.ptr as Pointer, cstr('v@:@'))
  objc.symbols.objc_registerClassPair(targetClass)
  const target = msg(msg(targetClass, 'alloc'), 'init')
  send(FFIType.void, [FFIType.ptr], nsMenu, sel('setDelegate:'), target)

  const statusBar = msg(cls('NSStatusBar'), 'systemStatusBar')
  const statusItem = send(FFIType.ptr, [FFIType.f64], statusBar, sel('statusItemWithLength:'), -1) as Pointer // variable length
  msg(statusItem, 'retain')
  const button = msg(statusItem, 'button')

  const png = new Uint8Array(readFileSync(iconPath))
  const data = send(FFIType.ptr, [FFIType.ptr, FFIType.u64], cls('NSData'), sel('dataWithBytes:length:'), png, png.length) as Pointer
  const image = msgPtr(msg(cls('NSImage'), 'alloc'), 'initWithData:', data)
  if (image) {
    // NSSize is two doubles, passed in floating-point registers on both arm64 and x86_64.
    send(FFIType.void, [FFIType.f64, FFIType.f64], image, sel('setSize:'), 18, 18)
    send(FFIType.void, [FFIType.bool], image, sel('setTemplate:'), true)
    send(FFIType.void, [FFIType.ptr], button, sel('setImage:'), image)
    send(FFIType.void, [FFIType.u64], button, sel('setImagePosition:'), 2) // image left of the title
  }
  send(FFIType.void, [FFIType.ptr], statusItem, sel('setMenu:'), nsMenu)
  rebuild()

  let lastTitle = ''
  const updateTitle = () => {
    const text = title()
    if (text === lastTitle) return
    lastTitle = text
    send(FFIType.void, [FFIType.ptr], button, sel('setTitle:'), nsString(text ? ` ${text}` : ''))
  }
  updateTitle()
  setInterval(updateTitle, 2000)

  const distantPast = msg(cls('NSDate'), 'distantPast')
  const runLoopMode = nsString('kCFRunLoopDefaultMode')
  setInterval(() => {
    for (let i = 0; i < 64; i++) {
      const event = send(FFIType.ptr, [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.bool], app,
        sel('nextEventMatchingMask:untilDate:inMode:dequeue:'), 0xffffffffffffffffn, distantPast, runLoopMode, true) as Pointer | null
      if (!event) break
      send(FFIType.void, [FFIType.ptr], app, sel('sendEvent:'), event)
    }
  }, 30)
  log.info('Menu-bar item ready')
}

function cstr(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf8')
}
