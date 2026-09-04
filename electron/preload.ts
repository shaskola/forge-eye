import { contextBridge, ipcRenderer } from 'electron'

export type ForgeSession = {
  accessToken: string
  httpBase: string
}

export type ForgeState = {
  expanded: boolean
  dragMode: boolean
  clickThrough: boolean
}

export type ForgeSettings = {
  opacity: number
}

export type ForgeBridge = {
  getState: () => Promise<ForgeState>
  setExpanded: (expanded: boolean) => void
  setPanelMode: (mode: 'list' | 'chat') => void
  setDockRows: (rows: number) => void
  setDragMode: (dragMode: boolean) => void
  setClickThrough: (clickThrough: boolean) => void
  focus: () => void
  onExpanded: (cb: (expanded: boolean) => void) => () => void
  onDragMode: (cb: (dragMode: boolean) => void) => () => void
  onClickThrough: (cb: (clickThrough: boolean) => void) => () => void
  getSession: () => Promise<ForgeSession | null>
  setSession: (session: ForgeSession) => Promise<boolean>
  clearSession: () => Promise<boolean>
  getSettings: () => Promise<ForgeSettings>
  setSettings: (settings: Partial<ForgeSettings>) => Promise<ForgeSettings>
}

const bridge: ForgeBridge = {
  getState: () => ipcRenderer.invoke('forge:get-state'),
  setExpanded: (expanded) => ipcRenderer.send('forge:set-expanded', expanded),
  setPanelMode: (mode) => ipcRenderer.send('forge:set-panel-mode', mode),
  setDockRows: (rows) => ipcRenderer.send('forge:set-dock-rows', rows),
  setDragMode: (dragMode) => ipcRenderer.send('forge:set-drag-mode', dragMode),
  setClickThrough: (clickThrough) => ipcRenderer.send('forge:set-click-through', clickThrough),
  focus: () => ipcRenderer.send('forge:focus'),
  onExpanded: (cb) => {
    const listener = (_: unknown, value: boolean) => cb(value)
    ipcRenderer.on('forge:expanded', listener)
    return () => ipcRenderer.removeListener('forge:expanded', listener)
  },
  onDragMode: (cb) => {
    const listener = (_: unknown, value: boolean) => cb(value)
    ipcRenderer.on('forge:drag-mode', listener)
    return () => ipcRenderer.removeListener('forge:drag-mode', listener)
  },
  onClickThrough: (cb) => {
    const listener = (_: unknown, value: boolean) => cb(value)
    ipcRenderer.on('forge:click-through', listener)
    return () => ipcRenderer.removeListener('forge:click-through', listener)
  },
  getSession: () => ipcRenderer.invoke('forge:get-session'),
  setSession: (session) => ipcRenderer.invoke('forge:set-session', session),
  clearSession: () => ipcRenderer.invoke('forge:clear-session'),
  getSettings: () => ipcRenderer.invoke('forge:get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('forge:set-settings', settings),
}

contextBridge.exposeInMainWorld('forge', bridge)
