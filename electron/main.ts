import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, parseLocale, translate, type Locale } from '../src/i18n/catalog'
import {
  type Anchor,
  DEFAULT_MARGIN,
  anchorFromBounds,
  boundsFromAnchor,
  defaultAnchor,
} from './layout'
import { setupAutoUpdate } from './updater'

type StoredSession = {
  accessToken: string
  httpBase: string
}

function sessionPath() {
  return path.join(app.getPath('userData'), 't3-session.json')
}

function readSession(): StoredSession | null {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null
    return {
      accessToken: parsed.accessToken,
      httpBase:
        typeof parsed.httpBase === 'string' && parsed.httpBase
          ? parsed.httpBase
          : 'http://127.0.0.1:3773',
    }
  } catch {
    return null
  }
}

function writeSession(session: StoredSession) {
  fs.writeFileSync(sessionPath(), JSON.stringify(session), 'utf8')
}

function clearSessionFile() {
  try {
    fs.unlinkSync(sessionPath())
  } catch {
    // ignore missing file
  }
}

type StoredSettings = {
  opacity: number
  locale: Locale
  anchorX: number | null
  anchorBottom: number | null
}

const DEFAULT_OPACITY = 0.7

function clampOpacity(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  return Math.min(1, Math.max(0.25, Math.round(n * 100) / 100))
}

function parseAnchorCoord(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.round(n)
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings(): StoredSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    return {
      opacity: clampOpacity(Number(parsed.opacity)),
      locale: parseLocale(parsed.locale),
      anchorX: parseAnchorCoord(parsed.anchorX),
      anchorBottom: parseAnchorCoord(parsed.anchorBottom),
    }
  } catch {
    return {
      opacity: DEFAULT_OPACITY,
      locale: DEFAULT_LOCALE,
      anchorX: null,
      anchorBottom: null,
    }
  }
}

function writeSettings(settings: StoredSettings) {
  const payload: Record<string, unknown> = {
    opacity: clampOpacity(settings.opacity),
    locale: parseLocale(settings.locale),
  }
  if (settings.anchorX != null && settings.anchorBottom != null) {
    payload.anchorX = Math.round(settings.anchorX)
    payload.anchorBottom = Math.round(settings.anchorBottom)
  }
  fs.writeFileSync(settingsPath(), JSON.stringify(payload), 'utf8')
}

function patchSettings(patch: Partial<StoredSettings>): StoredSettings {
  const current = readSettings()
  const next: StoredSettings = {
    opacity: patch.opacity != null ? clampOpacity(Number(patch.opacity)) : current.opacity,
    locale: patch.locale != null ? parseLocale(patch.locale) : current.locale,
    anchorX: patch.anchorX !== undefined ? parseAnchorCoord(patch.anchorX) : current.anchorX,
    anchorBottom: patch.anchorBottom !== undefined ? parseAnchorCoord(patch.anchorBottom) : current.anchorBottom,
  }
  writeSettings(next)
  return next
}

const PANEL_W = 380
const PANEL_H = 520
const CHAT_H = Math.round(PANEL_H * 1.5)
const DOCK_W = 360
const DOCK_ROW = 40
const DOCK_PAD = 8
const DOCK_MAX_ROWS = 9
const MARGIN = DEFAULT_MARGIN

let win: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = true
let dragMode = false
/** true = el mouse y los clics van al juego. Solo baja con Ctrl+Shift+C. */
let clickThrough = true
let dockRows = 1
let panelMode: 'list' | 'chat' = 'list'
let uiHidden = false
let currentLocale: Locale = DEFAULT_LOCALE
/** Bottom-left of the overlay. Null = default bottom-left of the primary screen. */
let anchor: Anchor | null = null
let persistAnchorTimer: ReturnType<typeof setTimeout> | null = null
let lastPassthrough: boolean | null = null

function dockHeight(rows: number) {
  const n = Math.max(1, Math.min(DOCK_MAX_ROWS, rows))
  return DOCK_PAD + n * DOCK_ROW
}

function targetSize() {
  if (expanded) {
    return { width: PANEL_W, height: panelMode === 'chat' ? CHAT_H : PANEL_H }
  }
  return { width: DOCK_W, height: dockHeight(dockRows) }
}

function workAreaFor(nextAnchor: Anchor | null) {
  if (nextAnchor) {
    return screen.getDisplayNearestPoint({
      x: Math.round(nextAnchor.x),
      y: Math.round(nextAnchor.bottom - 8),
    }).workArea
  }
  return screen.getPrimaryDisplay().workArea
}

function layoutBounds() {
  const size = targetSize()
  const area = workAreaFor(anchor)
  const nextAnchor = anchor ?? defaultAnchor(area, MARGIN)
  return boundsFromAnchor(nextAnchor, size.width, size.height, area)
}

function captureAnchor() {
  if (!win) return
  anchor = anchorFromBounds(win.getBounds())
}

function persistAnchorSoon() {
  if (!anchor) return
  if (persistAnchorTimer) clearTimeout(persistAnchorTimer)
  persistAnchorTimer = setTimeout(() => {
    persistAnchorTimer = null
    if (!anchor) return
    patchSettings({ anchorX: anchor.x, anchorBottom: anchor.bottom })
  }, 300)
}

function loadSavedAnchor() {
  const stored = readSettings()
  if (stored.anchorX != null && stored.anchorBottom != null) {
    anchor = { x: stored.anchorX, bottom: stored.anchorBottom }
  }
}

function onWindowMoved() {
  if (!win) return
  captureAnchor()
  persistAnchorSoon()
}

function setDockRows(next: number) {
  const rows = Math.max(1, Math.min(DOCK_MAX_ROWS, Math.round(next) || 1))
  if (rows === dockRows) {
    if (!expanded && win) layoutWindow()
    return
  }
  dockRows = rows
  if (!expanded) setExpanded(false)
}

function sameBounds(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function layoutWindow() {
  if (!win) return false
  const next = layoutBounds()
  const current = win.getBounds()
  if (sameBounds(current, next)) return false
  win.setBounds(next, false)
  return true
}

function applyBounds(opts?: { focus?: boolean }) {
  if (!win) return
  if (win.isVisible()) captureAnchor()
  const moved = layoutWindow()
  if (uiHidden) return
  win.setAlwaysOnTop(true, 'screen-saver')
  if (!win.isVisible()) {
    if (wantsPassthrough()) win.showInactive()
    else win.show()
    win.moveTop()
  } else if (moved) {
    win.moveTop()
  }
  // moveTop/show pueden devolver el hit-test en Windows: reaplicar al final.
  applyMousePassthrough(opts)
}

function wantsPassthrough(): boolean {
  if (dragMode) return false
  return clickThrough
}

function applyMousePassthrough(opts?: { focus?: boolean }) {
  if (!win) return
  const ignore = wantsPassthrough()
  if (lastPassthrough === ignore && !opts?.focus) return
  lastPassthrough = ignore
  if (ignore) {
    if (win.isFocused()) win.blur()
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true, { forward: false })
  } else {
    win.setIgnoreMouseEvents(false)
    win.setFocusable(true)
    if (opts?.focus) win.focus()
  }
  console.log('[forge-eye] passthrough', ignore, { expanded, clickThrough, dragMode })
}

function setPanelMode(next: 'list' | 'chat') {
  const mode = next === 'chat' ? 'chat' : 'list'
  if (mode === panelMode) return
  panelMode = mode
  if (expanded) applyBounds()
}

function publishClickThrough() {
  win?.webContents.send('forge:click-through', clickThrough)
}

function hideUi() {
  if (!win || uiHidden) return
  uiHidden = true
  dragMode = false
  clickThrough = true
  win.webContents.send('forge:drag-mode', false)
  publishClickThrough()
  win.hide()
}

function showUi(opts?: { focus?: boolean }) {
  if (!win) return
  uiHidden = false
  applyBounds(opts)
}

function toggleUiHidden() {
  if (!win) return
  if (uiHidden) showUi({ focus: false })
  else hideUi()
}

function setExpanded(next: boolean) {
  if (!win) return
  expanded = next
  if (!expanded) {
    panelMode = 'list'
    dragMode = false
    clickThrough = true
    win.webContents.send('forge:drag-mode', false)
  }
  applyBounds({ focus: !wantsPassthrough() })
  win.webContents.send('forge:expanded', expanded)
  publishClickThrough()
}

function toggleExpanded() {
  setExpanded(!expanded)
}

function reveal(opts?: { interactive?: boolean }) {
  if (!win) return
  uiHidden = false
  if (!expanded) expanded = true
  if (opts?.interactive) {
    dragMode = false
    clickThrough = false
    win.webContents.send('forge:drag-mode', false)
  }
  applyBounds({ focus: !wantsPassthrough() })
  win.webContents.send('forge:expanded', expanded)
  publishClickThrough()
}

function setDragMode(next: boolean) {
  if (!win) return
  uiHidden = false
  dragMode = next
  if (dragMode) {
    clickThrough = false
    if (!expanded) expanded = true
  } else {
    clickThrough = true
  }
  applyBounds({ focus: dragMode })
  win.webContents.send('forge:expanded', expanded)
  win.webContents.send('forge:drag-mode', dragMode)
  publishClickThrough()
}

function toggleClickThrough() {
  if (!win) return
  uiHidden = false
  if (dragMode) {
    dragMode = false
    win.webContents.send('forge:drag-mode', false)
  }
  clickThrough = !clickThrough
  if (!clickThrough && !expanded) expanded = true
  applyBounds({ focus: !clickThrough })
  win.webContents.send('forge:expanded', expanded)
  publishClickThrough()
}

function createWindow() {
  const bounds = layoutBounds()
  win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.once('ready-to-show', () => {
    if (!win) return
    if (wantsPassthrough()) win.showInactive()
    else win.show()
    win.moveTop()
    applyMousePassthrough({ focus: !wantsPassthrough() })
    console.log('[forge-eye] bounds', win.getBounds())
  })

  win.on('moved', onWindowMoved)
  win.on('focus', () => {
    if (wantsPassthrough()) applyMousePassthrough()
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[forge-eye] fail-load', code, desc, url)
  })

  win.on('closed', () => {
    win = null
  })
}

function applyTrayMenu() {
  if (!tray) return
  const t = (key: Parameters<typeof translate>[1]) => translate(currentLocale, key)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: t('trayShow'),
        click: () => reveal(),
      },
      {
        label: t('trayHide'),
        click: () => toggleUiHidden(),
      },
      {
        label: t('trayPanel'),
        click: () => toggleExpanded(),
      },
      {
        label: t('trayMove'),
        click: () => setDragMode(!dragMode),
      },
      {
        label: t('trayClick'),
        click: () => toggleClickThrough(),
      },
      { type: 'separator' },
      {
        label: t('trayQuit'),
        click: () => {
          app.quit()
        },
      },
    ]),
  )
}

function resolveAppIconPath() {
  const names = ['icon.ico', 'icon.png']
  const dirs = [
    path.join(app.getAppPath(), 'build'),
    path.join(__dirname, '..', 'build'),
    process.resourcesPath,
  ]
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) return file
    }
  }
  return null
}

function loadAppIcon() {
  const file = resolveAppIconPath()
  if (!file) return nativeImage.createEmpty()
  const icon = nativeImage.createFromPath(file)
  if (!icon.isEmpty()) return icon
  return nativeImage.createEmpty()
}

function createTray() {
  const icon = loadAppIcon()
  tray = new Tray(icon)
  tray.setToolTip('Forge Eye')
  applyTrayMenu()
  tray.on('click', () => reveal({ interactive: true }))
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleUiHidden()
  })
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (uiHidden) {
      uiHidden = false
      setExpanded(true)
      return
    }
    toggleExpanded()
  })
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    setDragMode(!dragMode)
  })
  globalShortcut.register('CommandOrControl+Shift+F', () => {
    reveal()
  })
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    toggleClickThrough()
  })
}

app.whenReady().then(() => {
  const stored = readSettings()
  currentLocale = stored.locale
  loadSavedAnchor()
  createWindow()
  createTray()
  registerShortcuts()
  setupAutoUpdate(() => win)
  screen.on('display-metrics-changed', () => {
    if (win && !uiHidden) applyBounds()
  })

  ipcMain.handle('forge:get-state', () => ({
    expanded,
    dragMode,
    clickThrough,
  }))

  ipcMain.handle('forge:get-session', () => readSession())

  ipcMain.handle('forge:set-session', (_e, session: StoredSession) => {
    if (!session?.accessToken || typeof session.accessToken !== 'string') {
      throw new Error(translate(currentLocale, 'noSession'))
    }
    writeSession({
      accessToken: session.accessToken,
      httpBase:
        typeof session.httpBase === 'string' && session.httpBase
          ? session.httpBase
          : 'http://127.0.0.1:3773',
    })
    return true
  })

  ipcMain.handle('forge:clear-session', () => {
    clearSessionFile()
    return true
  })

  ipcMain.handle('forge:get-settings', () => readSettings())

  ipcMain.handle('forge:set-settings', (_e, patch: Partial<StoredSettings>) => {
    const next = patchSettings(patch)
    if (next.locale !== currentLocale) {
      currentLocale = next.locale
      applyTrayMenu()
    }
    return next
  })

  ipcMain.on('forge:set-dock-rows', (_e, next: number) => {
    setDockRows(Number(next))
  })

  ipcMain.on('forge:set-panel-mode', (_e, next: string) => {
    setPanelMode(next === 'chat' ? 'chat' : 'list')
  })

  ipcMain.on('forge:set-expanded', (_e, next: boolean) => {
    setExpanded(Boolean(next))
  })

  ipcMain.on('forge:set-drag-mode', (_e, next: boolean) => {
    setDragMode(Boolean(next))
  })

  ipcMain.on('forge:set-click-through', (_e, next: boolean) => {
    clickThrough = Boolean(next)
    if (!clickThrough && !expanded) expanded = true
    if (clickThrough) dragMode = false
    applyBounds({ focus: !clickThrough })
    win?.webContents.send('forge:expanded', expanded)
    win?.webContents.send('forge:drag-mode', dragMode)
    publishClickThrough()
  })

  ipcMain.on('forge:focus', () => {
    reveal({ interactive: true })
  })

  ipcMain.on('forge:reveal', () => {
    reveal()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
