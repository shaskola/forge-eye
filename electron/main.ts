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

const PANEL_W = 380
const PANEL_H = 520
const CHAT_H = Math.round(PANEL_H * 1.5)
const DOCK_W = 360
const DOCK_ROW = 40
const DOCK_PAD = 8
const DOCK_MAX_ROWS = 8
const MARGIN = 24

let win: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = true
let dragMode = false
let clickThrough = false
let dockRows = 1
let panelMode: 'list' | 'chat' = 'list'

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
  if (!expanded) return true
  return clickThrough
}

function applyMousePassthrough(opts?: { focus?: boolean }) {
  if (!win) return
  const ignore = wantsPassthrough()
  if (ignore) {
    win.blur()
    win.setIgnoreMouseEvents(true)
    win.setFocusable(false)
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
  win.setAlwaysOnTop(true, 'screen-saver')
  applyMousePassthrough(opts)
  if (!win.isVisible()) win.show()
  win.moveTop()
}

function setPanelMode(next: 'list' | 'chat') {
  panelMode = next === 'chat' ? 'chat' : 'list'
  if (expanded) applyBounds()
}

function publishClickThrough() {
  win?.webContents.send('forge:click-through', clickThrough)
}

function setExpanded(next: boolean, opts?: { clickThrough?: boolean }) {
  if (!win) return
  expanded = next
  if (!expanded) {
    panelMode = 'list'
    clickThrough = false
  } else {
    clickThrough = opts?.clickThrough === true
  }
  applyBounds({ focus: expanded && !clickThrough })
  win.webContents.send('forge:expanded', expanded)
  publishClickThrough()
}

function toggleExpanded() {
  setExpanded(!expanded)
}

function reveal() {
  if (!win) return
  if (!expanded) setExpanded(true)
  else if (clickThrough) {
    clickThrough = false
    applyMousePassthrough({ focus: true })
    publishClickThrough()
  }
  win.show()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  if (!wantsPassthrough()) win.focus()
}

function setDragMode(next: boolean) {
  if (!win) return
  dragMode = next
  if (dragMode && clickThrough) {
    clickThrough = false
    publishClickThrough()
  }
  if (dragMode && !expanded) {
    setExpanded(true)
    return
  }
  applyMousePassthrough({ focus: dragMode || !clickThrough })
  win.webContents.send('forge:drag-mode', dragMode)
}

function toggleClickThrough() {
  if (!win) return
  if (dragMode) {
    dragMode = false
    win.webContents.send('forge:drag-mode', false)
  }
  if (!expanded) {
    setExpanded(true, { clickThrough: true })
    return
  }
  clickThrough = !clickThrough
  applyMousePassthrough({ focus: !clickThrough })
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
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
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
    win.show()
    win.moveTop()
    applyMousePassthrough({ focus: !wantsPassthrough() })
    console.log('[forge-eye] bounds', win.getBounds())
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
        label: 'Mostrar panel',
        click: () => reveal(),
      },
      {
        label: 'Mostrar / ocultar (Ctrl+Shift+A)',
        click: () => toggleExpanded(),
      },
      {
        label: 'Modo mover (Ctrl+Shift+D)',
        click: () => setDragMode(!dragMode),
      },
      {
        label: 'Clics al juego (Ctrl+Shift+C)',
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
  tray.on('click', () => reveal())
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+A', () => {
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
    if (Boolean(next) === clickThrough && expanded) return
    if (Boolean(next)) {
      if (!expanded) setExpanded(true, { clickThrough: true })
      else {
        clickThrough = true
        applyMousePassthrough()
        publishClickThrough()
      }
    } else {
      clickThrough = false
      applyMousePassthrough({ focus: true })
      publishClickThrough()
    }
  })

  ipcMain.on('forge:focus', () => {
    reveal()
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
