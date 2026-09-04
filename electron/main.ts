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
}

const DEFAULT_OPACITY = 0.7

function clampOpacity(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  return Math.min(1, Math.max(0.25, Math.round(n * 100) / 100))
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings(): StoredSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    return { opacity: clampOpacity(Number(parsed.opacity)) }
  } catch {
    return { opacity: DEFAULT_OPACITY }
  }
}

function writeSettings(settings: StoredSettings) {
  fs.writeFileSync(settingsPath(), JSON.stringify({ opacity: clampOpacity(settings.opacity) }), 'utf8')
}

const PANEL_W = 380
const PANEL_H = 520
const CHAT_H = Math.round(PANEL_H * 1.5)
const DOCK_W = 360
const DOCK_ROW = 40
const DOCK_PAD = 8
const DOCK_MAX_ROWS = 9
const MARGIN = 24

let win: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = true
let dragMode = false
/** true = el mouse y los clics van al juego. Solo baja con Ctrl+Shift+C. */
let clickThrough = true
let dockRows = 1
let panelMode: 'list' | 'chat' = 'list'
let uiHidden = false

function dockHeight(rows: number) {
  const n = Math.max(1, Math.min(DOCK_MAX_ROWS, rows))
  return DOCK_PAD + n * DOCK_ROW
}

function placeBottomLeft(width: number, height: number) {
  const display = screen.getPrimaryDisplay()
  const { workArea } = display
  const maxH = Math.max(120, workArea.height - MARGIN * 2)
  const h = Math.min(height, maxH)
  return {
    x: Math.round(workArea.x + MARGIN),
    y: Math.round(workArea.y + workArea.height - h - MARGIN),
    width,
    height: h,
  }
}

function wantsPassthrough(): boolean {
  if (dragMode) return false
  return clickThrough
}

function applyMousePassthrough(opts?: { focus?: boolean }) {
  if (!win) return
  const ignore = wantsPassthrough()
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

function setDockRows(next: number) {
  const rows = Math.max(1, Math.min(DOCK_MAX_ROWS, Math.round(next) || 1))
  if (rows === dockRows) {
    if (!expanded && win) {
      const size = placeBottomLeft(DOCK_W, dockHeight(dockRows))
      win.setBounds(size, false)
    }
    return
  }
  dockRows = rows
  if (!expanded) setExpanded(false)
}

function applyBounds(opts?: { focus?: boolean }) {
  if (!win) return
  const size = expanded
    ? placeBottomLeft(PANEL_W, panelMode === 'chat' ? CHAT_H : PANEL_H)
    : placeBottomLeft(DOCK_W, dockHeight(dockRows))
  win.setBounds(size, false)
  if (uiHidden) return
  win.setAlwaysOnTop(true, 'screen-saver')
  if (!win.isVisible()) {
    if (wantsPassthrough()) win.showInactive()
    else win.show()
  }
  win.moveTop()
  // moveTop/show pueden devolver el hit-test en Windows: reaplicar al final.
  applyMousePassthrough(opts)
}

function setPanelMode(next: 'list' | 'chat') {
  panelMode = next === 'chat' ? 'chat' : 'list'
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
  const bounds = placeBottomLeft(PANEL_W, PANEL_H)
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

function createTray() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBv+/DAwMjP8ZGBhGNYxqGPgG/P8PMkBq1KgGBgYGhv8MDAwA3h8EAZ6xV24AAAAASUVORK5CYII=',
    'base64',
  )
  const icon = nativeImage.createFromBuffer(png)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Forge Eye')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Mostrar panel (sigue el juego; Ctrl+Shift+C para pulsar)',
        click: () => reveal(),
      },
      {
        label: 'Ocultar / mostrar (Ctrl+Shift+H)',
        click: () => toggleUiHidden(),
      },
      {
        label: 'Mostrar / ocultar panel (Ctrl+Shift+A)',
        click: () => toggleExpanded(),
      },
      {
        label: 'Modo mover (Ctrl+Shift+D)',
        click: () => setDragMode(!dragMode),
      },
      {
        label: 'Pulsar overlay / clics al juego (Ctrl+Shift+C)',
        click: () => toggleClickThrough(),
      },
      { type: 'separator' },
      {
        label: 'Salir',
        click: () => {
          app.quit()
        },
      },
    ]),
  )
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
  createWindow()
  createTray()
  registerShortcuts()

  ipcMain.handle('forge:get-state', () => ({
    expanded,
    dragMode,
    clickThrough,
  }))

  ipcMain.handle('forge:get-session', () => readSession())

  ipcMain.handle('forge:set-session', (_e, session: StoredSession) => {
    if (!session?.accessToken || typeof session.accessToken !== 'string') {
      throw new Error('Sesión inválida')
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
    const current = readSettings()
    const next = { opacity: clampOpacity(Number(patch?.opacity ?? current.opacity)) }
    writeSettings(next)
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
