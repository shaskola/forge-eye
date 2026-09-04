/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    forge: {
      getState: () => Promise<{ expanded: boolean; dragMode: boolean; clickThrough: boolean }>
      setExpanded: (expanded: boolean) => void
      setPanelMode: (mode: 'list' | 'chat') => void
      setDockRows: (rows: number) => void
      setDragMode: (dragMode: boolean) => void
      setClickThrough: (clickThrough: boolean) => void
      focus: () => void
      onExpanded: (cb: (expanded: boolean) => void) => () => void
      onDragMode: (cb: (dragMode: boolean) => void) => () => void
      onClickThrough: (cb: (clickThrough: boolean) => void) => () => void
      getSession: () => Promise<{ accessToken: string; httpBase: string } | null>
      setSession: (session: { accessToken: string; httpBase: string }) => Promise<boolean>
      clearSession: () => Promise<boolean>
      getSettings: () => Promise<{ opacity: number }>
      setSettings: (settings: { opacity?: number }) => Promise<{ opacity: number }>
    }
  }
}
