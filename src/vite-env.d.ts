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
      getSettings: () => Promise<{ opacity: number; locale: 'en' | 'es' }>
      setSettings: (settings: { opacity?: number; locale?: 'en' | 'es' }) => Promise<{ opacity: number; locale: 'en' | 'es' }>
      getUpdate: () => Promise<{
        state:
          | 'dev'
          | 'idle'
          | 'checking'
          | 'available'
          | 'downloading'
          | 'ready'
          | 'unavailable'
          | 'error'
        version: string
        nextVersion?: string
        percent?: number
        error?: string
      }>
      checkUpdate: () => void
      installUpdate: () => void
      onUpdate: (
        cb: (status: {
          state:
            | 'dev'
            | 'idle'
            | 'checking'
            | 'available'
            | 'downloading'
            | 'ready'
            | 'unavailable'
            | 'error'
          version: string
          nextVersion?: string
          percent?: number
          error?: string
        }) => void,
      ) => () => void
    }
  }
}
