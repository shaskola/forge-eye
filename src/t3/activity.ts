export type ActivityTone = 'info' | 'tool' | 'approval' | 'error'

export type ThreadActivity = {
  id: string
  tone: ActivityTone
  kind: string
  title: string
  detail: string
  command: string
  files: string[]
  toolCallId: string | null
  createdAt: string
  turnId: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function stringifyBody(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const lines = value.map((item) => stringifyBody(item)).filter(Boolean)
    return lines.join('\n')
  }
  const rec = asRecord(value)
  if (!rec) return ''
  for (const key of ['text', 'content', 'output', 'stdout', 'result']) {
    const inner = rec[key]
    if (typeof inner === 'string' && inner.trim()) return inner.trim()
    if (Array.isArray(inner)) {
      const joined = stringifyBody(inner)
      if (joined) return joined
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

const SKIP_KINDS = new Set([
  'tool.started',
  'tool.progress',
  'task.updated',
  'context-window.updated',
])

function shouldSkip(kind: string, summary: string): boolean {
  if (SKIP_KINDS.has(kind)) return true
  if (summary === 'Checkpoint captured') return true
  return false
}

export function toThreadActivity(raw: Record<string, unknown>): ThreadActivity | null {
  const id = String(raw.id ?? '')
  if (!id) return null
  const kind = String(raw.kind ?? '')
  const summary = String(raw.summary ?? '').trim()
  if (shouldSkip(kind, summary)) return null

  const toneRaw = String(raw.tone ?? 'info')
  const tone: ActivityTone =
    toneRaw === 'tool' || toneRaw === 'approval' || toneRaw === 'error' ? toneRaw : 'info'

  const payload = asRecord(raw.payload)
  const data = asRecord(payload?.data)
  const item = asRecord(data?.item)
  const input = asRecord(data?.input) ?? asRecord(item?.input) ?? asRecord(item?.arguments)

  const title =
    asText(payload?.title) ||
    asText(data?.toolName) ||
    asText(item?.toolName) ||
    asText(item?.tool) ||
    asText(payload?.workflowName) ||
    asText(payload?.role) ||
    summary ||
    kind

  const command =
    asText(item?.command) ||
    asText(input?.command) ||
    asText(data?.command) ||
    asText(asRecord(item?.result)?.command)

  let detail = asText(payload?.detail)
  const resultText = stringifyBody(item?.result ?? data?.result)
  if (resultText && resultText !== detail) {
    detail = detail ? `${detail}\n\n${resultText}` : resultText
  }
  if (!detail && input) detail = stringifyBody(input)
  if (!detail) detail = asText(payload?.summary)

  const files: string[] = []
  const fileList = data?.files ?? item?.files ?? payload?.files
  if (Array.isArray(fileList)) {
    for (const file of fileList) {
      const rec = asRecord(file)
      const path = rec ? asText(rec.path) || asText(rec.file_path) : asText(file)
      if (path) files.push(path)
    }
  }
  const filePath = asText(input?.file_path) || asText(input?.path)
  if (filePath) files.push(filePath)

  const toolCallId =
    asText(data?.toolCallId) ||
    asText(data?.toolUseId) ||
    asText(item?.toolCallId) ||
    asText(item?.tool_use_id) ||
    null

  return {
    id,
    tone,
    kind,
    title,
    detail,
    command,
    files: [...new Set(files)],
    toolCallId,
    createdAt: String(raw.createdAt ?? ''),
    turnId: raw.turnId == null ? null : String(raw.turnId),
  }
}

export function normalizeActivities(raw: unknown[]): ThreadActivity[] {
  const collected: ThreadActivity[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const activity = toThreadActivity(item as Record<string, unknown>)
    if (activity) collected.push(activity)
  }
  return collapseActivities(collected)
}

export function collapseActivities(list: ThreadActivity[]): ThreadActivity[] {
  const byKey = new Map<string, ThreadActivity>()
  const order: string[] = []
  for (const activity of list) {
    const key = activity.toolCallId || activity.id
    if (!byKey.has(key)) order.push(key)
    byKey.set(key, activity)
  }
  return order.map((key) => byKey.get(key)!)
}

export function upsertActivity(list: ThreadActivity[], incoming: ThreadActivity): ThreadActivity[] {
  return collapseActivities([...list.filter((item) => item.id !== incoming.id), incoming])
}
