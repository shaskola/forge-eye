import { translate, translateKey, type Locale, type MsgKey, type TranslateVars } from './catalog'

export class AppError extends Error {
  readonly key: MsgKey
  readonly params: TranslateVars

  constructor(key: MsgKey, params: TranslateVars = {}) {
    super(key)
    this.name = 'AppError'
    this.key = key
    this.params = params
  }
}

export function formatUnknownError(locale: Locale, err: unknown, fallback: MsgKey): string {
  if (err instanceof AppError) return translate(locale, err.key, err.params)
  if (err instanceof Error && err.message) return err.message
  return translate(locale, fallback)
}

export function formatStoredError(
  locale: Locale,
  key: string,
  params: TranslateVars,
  raw: string,
): string {
  if (key) return translateKey(locale, key, params)
  return raw
}
