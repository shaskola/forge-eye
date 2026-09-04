export type AgentStatus = 'idle' | 'running' | 'error' | 'unknown'

export type AgentThread = {
  id: string
  projectId: string
  projectTitle: string
  title: string
  status: AgentStatus
  lastLine: string
  startedAt?: string | null
  pendingApproval?: boolean
}

import {
  collapseActivities,
  normalizeActivities,
  toThreadActivity,
  upsertActivity,
  type ThreadActivity,
} from './activity'

export type { ThreadActivity } from './activity'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt?: string
  streaming?: boolean
}

export type ConnectionState =
  | 'needs_pair'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error'

type SnapshotLike = {
  projects?: Array<Record<string, unknown>>
  threads?: Array<Record<string, unknown>>
}

type Listener = () => void

const DEFAULT_HTTP_BASE = 'http://127.0.0.1:3773'
const STORAGE_TOKEN = 'forge-eye.t3.accessToken'
const STORAGE_HTTP = 'forge-eye.t3.httpBase'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TOKEN_TYPE = 'urn:t3:params:oauth:token-type:environment-bootstrap'
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

function uuid() {
  return crypto.randomUUID()
}

function toWsUrl(httpBase: string, ticket: string) {
  const u = new URL(httpBase)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  u.search = ''
  u.hash = ''
  u.searchParams.set('wsTicket', ticket)
  return u.toString()
}

function normalizeHttpBase(raw: string) {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('El host de pairing debe ser http(s)')
  }
  return `${u.protocol}//${u.host}`
}

export type PairingTarget = {
  credential: string
  httpBase: string
}

/** Extrae token + host de un enlace de pairing, o token plano + localhost. */
export function parsePairingInput(input: string): PairingTarget {
  const raw = input.trim()
  if (!raw) throw new Error('Pega un enlace o token de pairing de T3')

  if (raw.includes('://') || raw.includes('#') || raw.startsWith('/')) {
    const url = new URL(raw, DEFAULT_HTTP_BASE)
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    const hashParams = new URLSearchParams(hash)
    const credential = (
      hashParams.get('token') ??
      hashParams.get('credential') ??
      url.searchParams.get('token') ??
      url.searchParams.get('credential') ??
      ''
    ).trim()
    if (!credential) throw new Error('El enlace no trae token (#token=…)')
    const hostedHost = url.searchParams.get('host')
    const httpBase = hostedHost
      ? normalizeHttpBase(hostedHost.includes('://') ? hostedHost : `http://${hostedHost}`)
      : normalizeHttpBase(`${url.protocol}//${url.host}`)
    return { credential, httpBase }
  }

  return { credential: raw, httpBase: DEFAULT_HTTP_BASE }
}

function formatAuthError(status: number, json: Record<string, unknown>) {
  const reason = String(json.reason ?? json.error_description ?? json.message ?? json.error ?? '')
  if (reason === 'scope_not_granted') {
    return 'El enlace no otorga esos permisos. Crea un Create Link nuevo e inténtalo otra vez.'
  }
  if (reason === 'invalid_credential') {
    return 'Token inválido o ya usado. En T3: Create Link de nuevo y pégalo aquí.'
  }
  if (reason === 'invalid_scope') {
    return 'Scopes inválidos en la petición de pairing.'
  }
  if (reason) return `${reason} (${status})`
  return `Pairing falló (${status})`
}

/** Mismo criterio de T3: pending / sesión viva / override active = abierto. */
function isUnsettled(t: Record<string, unknown>): boolean {
  if (t.hasPendingApprovals || t.hasPendingUserInput) return true
  const session = (t.session ?? null) as Record<string, unknown> | null
  const sessionStatus = String(session?.status ?? '')
  if (sessionStatus === 'starting' || sessionStatus === 'running') return true
  const latestTurn = (t.latestTurn ?? null) as Record<string, unknown> | null
  if (latestTurn && String(latestTurn.state ?? '') === 'running') return true
  if (t.backgroundLiveness === 'working') return true
  if (t.settledOverride === 'settled') return false
  return true
}

function asStatus(raw: unknown): AgentStatus {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('run') || s === 'starting' || s === 'streaming' || s === 'busy') return 'running'
  if (s.includes('error') || s.includes('fail')) return 'error'
  if (s.includes('ready') || s.includes('idle') || s === 'connected' || s === 'stopped') return 'idle'
  return 'unknown'
}

function firstIso(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    if (Number.isFinite(Date.parse(value))) return value
  }
  return null
}

function resolveStartedAt(t: Record<string, unknown>): string | null {
  const session = (t.session ?? null) as Record<string, unknown> | null
  const latestTurn = (t.latestTurn ?? null) as Record<string, unknown> | null
  if (latestTurn && latestTurn.completedAt == null) {
    return firstIso(latestTurn.startedAt, latestTurn.requestedAt, session?.updatedAt)
  }
  return firstIso(session?.updatedAt)
}

function normalizeSnapshot(snapshot: SnapshotLike): AgentThread[] {
  const projects = new Map<string, string>()
  for (const p of snapshot.projects ?? []) {
    const id = String(p.id ?? p.projectId ?? '')
    if (!id) continue
    projects.set(id, String(p.title ?? p.name ?? 'Proyecto'))
  }

  const out: AgentThread[] = []
  for (const t of snapshot.threads ?? []) {
    const id = String(t.id ?? t.threadId ?? '')
    if (!id) continue
    if (t.archivedAt) continue
    if (!isUnsettled(t)) continue
    const projectId = String(t.projectId ?? '')
    const session = (t.session ?? {}) as Record<string, unknown>
    const latestTurn = (t.latestTurn ?? null) as Record<string, unknown> | null
    const planProgress = (t.planProgress ?? null) as Record<string, unknown> | null
    const turnState = latestTurn ? String(latestTurn.state ?? '') : ''
    const background = String(t.backgroundLiveness ?? '')

    let status = asStatus(session.status)
    if (status === 'unknown' || status === 'idle') {
      if (turnState === 'running' || background === 'working') status = 'running'
      else if (turnState === 'error' || session.lastError) status = 'error'
      else if (turnState === 'completed' || turnState === 'interrupted' || !latestTurn) status = 'idle'
    }

    const lastLine =
      String(planProgress?.step ?? '').trim() ||
      String(session.lastError ?? '').trim() ||
      (status === 'running'
        ? background === 'monitoring'
          ? 'Monitoreando…'
          : 'Trabajando…'
        : turnState === 'completed'
          ? 'Turno completado'
          : 'Sin actividad reciente')

    out.push({
      id,
      projectId,
      projectTitle: projects.get(projectId) ?? 'Proyecto',
      title: String(t.title ?? 'Hilo'),
      status,
      lastLine: lastLine.slice(0, 160),
      startedAt: status === 'running' ? resolveStartedAt(t) : null,
      pendingApproval: Boolean(t.hasPendingApprovals ?? t.pendingApproval),
    })
  }

  out.sort((a, b) => {
    const rank = (s: AgentStatus) => (s === 'running' ? 0 : s === 'error' ? 1 : 2)
    return rank(a.status) - rank(b.status) || a.title.localeCompare(b.title)
  })
  return out
}

function toChatMessage(raw: Record<string, unknown>): ChatMessage | null {
  const id = String(raw.id ?? raw.messageId ?? '')
  const role = String(raw.role ?? '')
  if (!id || (role !== 'user' && role !== 'assistant' && role !== 'system')) return null
  return {
    id,
    role,
    text: String(raw.text ?? ''),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    streaming: Boolean(raw.streaming),
  }
}

function normalizeMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const msg = toChatMessage(item as Record<string, unknown>)
    if (msg) out.push(msg)
  }
  return out
}

export class T3Client {
  private ws: WebSocket | null = null
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private listeners = new Set<Listener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private accessToken: string | null = null
  private httpBase: string = DEFAULT_HTTP_BASE
  private connecting = false
  private connectGen = 0
  private rawProjects: Array<Record<string, unknown>> = []
  private rawThreads: Array<Record<string, unknown>> = []
  private threadRequestId: string | null = null
  private previews = new Map<string, string>()
  private workingSince = new Map<string, string>()

  connection: ConnectionState = 'needs_pair'
  threads: AgentThread[] = []
  messages: ChatMessage[] = []
  activities: ThreadActivity[] = []
  openThreadId: string | null = null
  chatLoading = false
  lastError = ''
  ready = false

  constructor() {
    this.accessToken = localStorage.getItem(STORAGE_TOKEN)
    this.httpBase = localStorage.getItem(STORAGE_HTTP) || DEFAULT_HTTP_BASE
    if (this.accessToken) this.connection = 'connecting'
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  hasCredential() {
    return Boolean(this.accessToken)
  }

  private async persistSession() {
    if (!this.accessToken) return
    localStorage.setItem(STORAGE_TOKEN, this.accessToken)
    localStorage.setItem(STORAGE_HTTP, this.httpBase)
    try {
      await window.forge?.setSession({
        accessToken: this.accessToken,
        httpBase: this.httpBase,
      })
    } catch (err) {
      console.warn('[forge-eye] no se pudo guardar sesión en disco', err)
    }
  }

  /** Carga sesión desde disco Electron (sobrevive reinicios / cambios de origen Vite). */
  async hydrate() {
    try {
      const disk = await window.forge?.getSession()
      if (disk?.accessToken) {
        this.accessToken = disk.accessToken
        this.httpBase = disk.httpBase || DEFAULT_HTTP_BASE
        localStorage.setItem(STORAGE_TOKEN, disk.accessToken)
        localStorage.setItem(STORAGE_HTTP, this.httpBase)
      }
    } catch (err) {
      console.warn('[forge-eye] no se pudo leer sesión de disco', err)
    }
    this.ready = true
    this.connection = this.accessToken ? 'connecting' : 'needs_pair'
    this.emit()
  }

  clearCredential() {
    this.accessToken = null
    localStorage.removeItem(STORAGE_TOKEN)
    localStorage.removeItem(STORAGE_HTTP)
    void window.forge?.clearSession()
    this.httpBase = DEFAULT_HTTP_BASE
    this.ws?.close()
    this.connection = 'needs_pair'
    this.threads = []
    this.lastError = ''
    this.emit()
  }

  async pairWithCredential(rawInput: string) {
    const { credential, httpBase } = parsePairingInput(rawInput)

    // No pedir `scope`: T3 consume el token one-time ANTES de validar scopes.
    // Si pedimos de más (p. ej. access:read) → 400 scope_not_granted y el link muere.
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: credential,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      client_label: 'Forge Eye',
      client_device_type: 'desktop',
      client_os: 'Windows',
    })

    const res = await fetch(`${httpBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new Error(formatAuthError(res.status, json))
    }

    this.accessToken = json.access_token
    this.httpBase = httpBase
    await this.persistSession()
    this.lastError = ''
    this.connection = 'connecting'
    this.emit()
    await this.connect()
  }

  private async mintWsTicket(): Promise<string> {
    if (!this.accessToken) throw new Error('Sin sesión T3')
    const res = await fetch(`${this.httpBase}/api/auth/websocket-ticket`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const json = (await res.json().catch(() => ({}))) as {
      ticket?: string
      message?: string
      reason?: string
    }
    if (!res.ok || !json.ticket) {
      // No borrar la sesión automáticamente: T3 puede listar el cliente aunque
      // el ticket falle un momento. El usuario desempareja a mano si hace falta.
      if (res.status === 401) {
        throw new Error(
          'T3 rechazó la sesión (401). En Connections, Revoke del cliente viejo, Create Link nuevo y vuelve a Emparejar.',
        )
      }
      throw new Error(json.message ?? json.reason ?? `Ticket WS falló (${res.status})`)
    }
    return json.ticket
  }

  async connect(options?: { force?: boolean }) {
    if (options?.force) {
      this.disconnect({ scheduleReconnect: false })
    }
    if (this.connecting) return
    if (!this.accessToken) {
      this.connection = 'needs_pair'
      this.emit()
      return
    }

    const generation = ++this.connectGen
    this.connecting = true
    this.connection = 'connecting'
    this.emit()

    try {
      const ticket = await this.mintWsTicket()
      if (generation !== this.connectGen) return
      const url = toWsUrl(this.httpBase, ticket)
      this.ws?.close()
      this.ws = new WebSocket(url)
    } catch (err) {
      if (generation !== this.connectGen) return
      this.connecting = false
      this.connection = this.accessToken ? 'error' : 'needs_pair'
      this.lastError = err instanceof Error ? err.message : 'No se pudo abrir WebSocket'
      this.emit()
      this.scheduleReconnect()
      return
    }

    this.handshakeTimer = setTimeout(() => {
      if (generation !== this.connectGen) return
      if (this.ws?.readyState === WebSocket.OPEN) return
      this.lastError = 'T3 no respondió al WebSocket. Pulsa Reconectar.'
      this.connection = 'error'
      this.connecting = false
      this.emit()
      this.ws?.close()
    }, 8000)

    this.ws.onopen = () => {
      if (generation !== this.connectGen) return
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
      }
      this.connecting = false
      this.connection = 'online'
      this.lastError = ''
      this.emit()
      this.subscribeShell()
    }

    this.ws.onmessage = (ev) => {
      void this.handleMessage(String(ev.data))
    }

    this.ws.onerror = () => {
      if (generation !== this.connectGen) return
      this.connecting = false
      this.lastError = 'Error de conexión con T3 Code'
      this.connection = 'error'
      this.emit()
    }

    this.ws.onclose = () => {
      if (generation !== this.connectGen) return
      this.connecting = false
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
      }
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
      this.connection = this.accessToken ? 'offline' : 'needs_pair'
      this.emit()
      this.scheduleReconnect()
    }
  }

  /** Cierra el socket sin matar la sesión. React remonta el panel; esto no debe quemar el cliente. */
  disconnect(options?: { scheduleReconnect?: boolean }) {
    this.connectGen += 1
    this.connecting = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.threadRequestId = null
    this.openThreadId = null
    this.chatLoading = false
    this.messages = []
    this.activities = []
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }
    if (options?.scheduleReconnect) this.scheduleReconnect()
  }

  dispose() {
    this.disconnect({ scheduleReconnect: false })
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer || !this.accessToken) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 3000)
  }

  private async handleMessage(raw: string) {
    let messages: unknown[]
    try {
      const parsed = JSON.parse(raw) as unknown
      messages = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }

    for (const item of messages) {
      if (!item || typeof item !== 'object') continue
      const msg = item as Record<string, unknown>
      const tag = String(msg._tag ?? '')

      if (tag === 'Defect' || tag === 'ClientProtocolError') {
        const detail = JSON.stringify(msg).slice(0, 240)
        console.warn('[forge-eye] rpc defect', detail)
        continue
      }

      if (tag === 'Chunk') {
        const values = Array.isArray(msg.values) ? msg.values : []
        for (const value of values) {
          if (value && typeof value === 'object') this.applyStreamItem(value as Record<string, unknown>)
        }
        continue
      }

      if (tag !== 'Exit') continue

      const requestId = String(msg.requestId ?? '')
      if (!requestId || !this.pending.has(requestId)) continue
      const entry = this.pending.get(requestId)!
      this.pending.delete(requestId)

      const exit = msg.exit as Record<string, unknown> | undefined
      if (!exit) {
        entry.reject(new Error('Respuesta RPC vacía'))
        continue
      }

      if (exit._tag === 'Success') {
        entry.resolve(exit.value)
        continue
      }

      if (exit._tag === 'Failure') {
        const cause = Array.isArray(exit.cause) ? exit.cause : []
        const fail = cause.find((c) => c && typeof c === 'object' && (c as { _tag?: string })._tag === 'Fail') as
          | { error?: { message?: string; _tag?: string } }
          | undefined
        const die = cause.find((c) => c && typeof c === 'object' && (c as { _tag?: string })._tag === 'Die') as
          | { defect?: unknown }
          | undefined
        const message =
          fail?.error?.message ??
          (typeof die?.defect === 'string' ? die.defect : null) ??
          fail?.error?._tag ??
          'Error RPC T3'
        entry.reject(new Error(message))
        continue
      }

      entry.reject(new Error('Exit RPC desconocido'))
    }
  }

  private request(tag: string, payload: unknown = {}, timeoutMs = 12000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('T3 Code no está conectado'))
        return
      }
      const id = uuid()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Tiempo de espera agotado'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      // Effect RPC wire format (not the old { id, body: { _tag } } docs)
      this.ws.send(
        JSON.stringify({
          _tag: 'Request',
          id,
          tag,
          payload,
          headers: [],
        }),
      )
    })
  }

  private publishThreads() {
    this.threads = normalizeSnapshot({
      projects: this.rawProjects,
      threads: this.rawThreads,
    }).map((thread) => {
      const forcedStart = this.workingSince.get(thread.id)
      if (forcedStart) {
        const raw = this.rawThreads.find((t) => String(t.id) === thread.id)
        const latestTurn = (raw?.latestTurn ?? null) as Record<string, unknown> | null
        const completedMs = Date.parse(String(latestTurn?.completedAt ?? ''))
        const forcedMs = Date.parse(forcedStart)
        const finishedAfterSend =
          Number.isFinite(completedMs) && Number.isFinite(forcedMs) && completedMs >= forcedMs
        if (thread.status === 'running' && thread.startedAt) {
          this.workingSince.set(thread.id, thread.startedAt)
        } else if (finishedAfterSend) {
          this.workingSince.delete(thread.id)
        } else {
          thread = { ...thread, status: 'running', startedAt: thread.startedAt ?? forcedStart }
        }
      }
      const preview = this.previews.get(thread.id)
      if (preview && thread.status !== 'running') {
        thread = { ...thread, lastLine: preview }
      }
      return thread
    })
    this.lastError = ''
    this.emit()
  }

  private markWorking(threadId: string, startedAt = new Date().toISOString()) {
    this.workingSince.set(threadId, startedAt)
    this.patchRawThread(threadId, {
      session: {
        ...(((this.rawThreads.find((t) => String(t.id) === threadId)?.session ?? {}) as Record<
          string,
          unknown
        >) ?? {}),
        status: 'running',
        updatedAt: startedAt,
      },
      latestTurn: {
        ...(((this.rawThreads.find((t) => String(t.id) === threadId)?.latestTurn ?? {}) as Record<
          string,
          unknown
        >) ?? {}),
        state: 'running',
        startedAt,
        requestedAt: startedAt,
        completedAt: null,
      },
    })
    this.publishThreads()
  }

  private patchRawThread(threadId: string, patch: Record<string, unknown>) {
    const idx = this.rawThreads.findIndex((t) => String(t.id) === threadId)
    if (idx < 0) return
    this.rawThreads[idx] = { ...this.rawThreads[idx], ...patch }
  }

  private setMessages(messages: ChatMessage[], threadId?: string) {
    this.messages = messages
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim())
    if (threadId && lastAssistant) {
      this.previews.set(threadId, lastAssistant.text.replace(/\s+/g, ' ').slice(0, 160))
    }
    this.emit()
  }

  private setActivities(activities: ThreadActivity[]) {
    this.activities = collapseActivities(activities)
    this.emit()
  }

  private applyStreamItem(item: Record<string, unknown>) {
    const kind = String(item.kind ?? '')
    if (kind === 'snapshot') {
      const snapshot = (item.snapshot ?? {}) as Record<string, unknown>
      const detail = snapshot.thread as Record<string, unknown> | undefined
      if (detail && Array.isArray(detail.messages)) {
        const threadId = String(detail.id ?? this.openThreadId ?? '')
        this.chatLoading = false
        if (threadId) {
          this.patchRawThread(threadId, {
            session: detail.session,
            latestTurn: detail.latestTurn,
            planProgress: detail.planProgress,
            hasPendingApprovals: detail.hasPendingApprovals,
            hasPendingUserInput: detail.hasPendingUserInput,
            backgroundLiveness: detail.backgroundLiveness,
            settledOverride: detail.settledOverride,
          })
          this.publishThreads()
        }
        this.setMessages(normalizeMessages(detail.messages), threadId || undefined)
        this.setActivities(normalizeActivities((detail.activities as unknown[]) ?? []))
        return
      }
      this.rawProjects = (snapshot.projects as Array<Record<string, unknown>>) ?? []
      this.rawThreads = (snapshot.threads as Array<Record<string, unknown>>) ?? []
      this.publishThreads()
      return
    }
    if (kind === 'event') {
      const event = (item.event ?? {}) as Record<string, unknown>
      const type = String(event.type ?? '')
      const payload = (event.payload ?? {}) as Record<string, unknown>
      const threadId = String(payload.threadId ?? event.aggregateId ?? this.openThreadId ?? '')
      if (type === 'thread.session-set' && threadId && payload.session) {
        this.patchRawThread(threadId, { session: payload.session })
        this.publishThreads()
      }
      if (type === 'thread.turn-start-requested' && threadId) {
        this.markWorking(threadId, String(payload.createdAt ?? new Date().toISOString()))
      }
      if (type === 'thread.activity-appended') {
        const rawActivity =
          payload.activity && typeof payload.activity === 'object'
            ? (payload.activity as Record<string, unknown>)
            : null
        const incoming = rawActivity ? toThreadActivity(rawActivity) : null
        if (incoming && (!this.openThreadId || threadId === this.openThreadId)) {
          this.setActivities(upsertActivity(this.activities, incoming))
        }
      }
      if (type !== 'thread.message-sent') return
      const incoming = toChatMessage(payload)
      if (!incoming || (this.openThreadId && threadId !== this.openThreadId)) return
      const next = this.messages.filter((m) => m.id !== incoming.id)
      next.push(incoming)
      this.setMessages(next, this.openThreadId ?? undefined)
      return
    }
    if (kind === 'thread-upserted' && item.thread && typeof item.thread === 'object') {
      const thread = item.thread as Record<string, unknown>
      const id = String(thread.id ?? '')
      if (!id) return
      const idx = this.rawThreads.findIndex((t) => String(t.id) === id)
      if (idx >= 0) this.rawThreads[idx] = thread
      else this.rawThreads.push(thread)
      this.publishThreads()
      return
    }
    if (kind === 'thread-removed') {
      const id = String(item.threadId ?? '')
      if (!id) return
      this.rawThreads = this.rawThreads.filter((t) => String(t.id) !== id)
      this.publishThreads()
    }
  }

  private subscribeShell() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        _tag: 'Request',
        id: uuid(),
        tag: 'orchestration.subscribeShell',
        payload: {},
        headers: [],
      }),
    )
  }

  async refreshSnapshot() {
    this.subscribeShell()
  }

  openThread(threadId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.closeThread()
    this.openThreadId = threadId
    this.chatLoading = true
    this.messages = []
    this.activities = []
    this.emit()
    const id = uuid()
    this.threadRequestId = id
    this.ws.send(
      JSON.stringify({
        _tag: 'Request',
        id,
        tag: 'orchestration.subscribeThread',
        payload: { threadId, turnLimit: 16 },
        headers: [],
      }),
    )
  }

  closeThread() {
    if (this.threadRequestId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          _tag: 'Interrupt',
          requestId: this.threadRequestId,
        }),
      )
    }
    this.threadRequestId = null
    this.openThreadId = null
    this.chatLoading = false
    this.messages = []
    this.activities = []
    this.emit()
  }

  async sendMessage(threadId: string, text: string) {
    const trimmed = text.trim()
    if (!trimmed) throw new Error('Mensaje vacío')

    const command = {
      type: 'thread.turn.start',
      commandId: uuid(),
      threadId,
      message: {
        messageId: uuid(),
        role: 'user',
        text: trimmed,
        attachments: [],
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      createdAt: new Date().toISOString(),
    }

    await this.request('orchestration.dispatchCommand', command)

    if (this.openThreadId === threadId) {
      this.setMessages(
        [
          ...this.messages,
          { id: command.message.messageId, role: 'user', text: trimmed, createdAt: command.createdAt },
        ],
        threadId,
      )
    }
    this.markWorking(threadId, command.createdAt)
  }

  async interrupt(threadId: string) {
    const command = {
      type: 'thread.turn.interrupt',
      commandId: uuid(),
      threadId,
      createdAt: new Date().toISOString(),
    }
    await this.request('orchestration.dispatchCommand', command)
    await this.refreshSnapshot()
  }
}
