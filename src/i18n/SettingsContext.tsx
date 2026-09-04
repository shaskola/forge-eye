import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseLocale, translate, type Locale, type MsgKey, type TranslateVars } from './catalog'

const STORAGE_OPACITY = 'forge-eye.opacity'
const STORAGE_LOCALE = 'forge-eye.locale'
const DEFAULT_OPACITY = 0.7

function clampOpacity(n: number) {
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  return Math.min(1, Math.max(0.25, Math.round(n * 100) / 100))
}

function readStoredOpacity() {
  const raw = localStorage.getItem(STORAGE_OPACITY)
  if (raw == null || raw === '') return DEFAULT_OPACITY
  return clampOpacity(Number(raw))
}

function applyOpacityCss(value: number) {
  document.documentElement.style.setProperty('--overlay-opacity', String(value))
}

type SettingsContextValue = {
  locale: Locale
  opacity: number
  setLocale: (locale: Locale) => void
  setOpacity: (opacity: number) => void
  t: (key: MsgKey, vars?: TranslateVars) => string
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => parseLocale(localStorage.getItem(STORAGE_LOCALE)))
  const [opacity, setOpacityState] = useState(() => readStoredOpacity())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const storedOpacity = readStoredOpacity()
      const storedLocale = parseLocale(localStorage.getItem(STORAGE_LOCALE))
      let nextOpacity = storedOpacity
      let nextLocale = storedLocale
      try {
        const disk = await window.forge?.getSettings()
        if (disk && Number.isFinite(disk.opacity)) nextOpacity = clampOpacity(disk.opacity)
        if (disk) nextLocale = parseLocale(disk.locale)
      } catch {
        // browser preview: localStorage only
      }
      if (cancelled) return
      setOpacityState(nextOpacity)
      setLocaleState(nextLocale)
      applyOpacityCss(nextOpacity)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    applyOpacityCss(opacity)
  }, [opacity])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const persist = useCallback((next: { opacity: number; locale: Locale }) => {
    localStorage.setItem(STORAGE_OPACITY, String(next.opacity))
    localStorage.setItem(STORAGE_LOCALE, next.locale)
    void window.forge?.setSettings({ opacity: next.opacity, locale: next.locale })
  }, [])

  const setOpacity = useCallback(
    (raw: number) => {
      const nextOpacity = clampOpacity(raw)
      setOpacityState(nextOpacity)
      applyOpacityCss(nextOpacity)
      persist({ opacity: nextOpacity, locale })
    },
    [locale, persist],
  )

  const setLocale = useCallback(
    (nextLocale: Locale) => {
      setLocaleState(nextLocale)
      persist({ opacity, locale: nextLocale })
    },
    [opacity, persist],
  )

  const t = useCallback((key: MsgKey, vars?: TranslateVars) => translate(locale, key, vars), [locale])

  const value = useMemo(
    () => ({ locale, opacity, setLocale, setOpacity, t }),
    [locale, opacity, setLocale, setOpacity, t],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('SettingsProvider is missing')
  return ctx
}
