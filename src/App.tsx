import { useEffect, useMemo, useRef, useState } from 'react'
import { SolarIcon } from './icons/SolarIcon'
import { T3Client, type AgentThread, type ChatMessage, type ConnectionState, type ThreadActivity } from './t3/client'
import type { ActivityTone } from './t3/activity'

const statusLabel: Record<string, string> = {
  idle: 'listo',
  running: 'trabajando',
  error: 'error',
  unknown: '—',
}

function formatElapsed(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  if (!Number.isFinite(elapsed)) return null
  const hours = Math.floor(elapsed / 3600)
  const minutes = Math.floor((elapsed % 3600) / 60)
  const seconds = elapsed % 60
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

function statusText(thread: Pick<AgentThread, 'status' | 'startedAt'>, now: number): string {
  if (thread.status !== 'running') return statusLabel[thread.status] ?? statusLabel.unknown
  return formatElapsed(thread.startedAt, now) ?? 'trabajando'
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const connectionLabel: Record<ConnectionState, string> = {
  needs_pair: 'sin emparejar',
  connecting: 'conectando…',
  online: 'T3 en línea',
  offline: 'T3 offline',
  error: 'error de enlace',
}

function useForgeWindow() {
  const [expanded, setExpanded] = useState(true)
  const [dragMode, setDragMode] = useState(false)
  const [clickThrough, setClickThrough] = useState(false)

  useEffect(() => {
    const api = window.forge
    if (!api) return
    void api.getState().then((s) => {
      setExpanded(s.expanded)
      setDragMode(s.dragMode)
      setClickThrough(s.clickThrough)
    })
    const offA = api.onExpanded(setExpanded)
    const offB = api.onDragMode(setDragMode)
    const offC = api.onClickThrough(setClickThrough)
    return () => {
      offA()
      offB()
      offC()
    }
  }, [])

  return {
    expanded,
    dragMode,
    clickThrough,
    open: () => window.forge?.setExpanded(true),
    close: () => {
      window.forge?.setDragMode(false)
      window.forge?.setExpanded(false)
    },
    toggleDrag: () => window.forge?.setDragMode(!dragMode),
  }
}

function useT3() {
  const [client] = useState(() => new T3Client())
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = client.subscribe(() => setTick((n) => n + 1))
    let cancelled = false
    void (async () => {
      await client.hydrate()
      if (!cancelled) void client.connect()
    })()
    return () => {
      cancelled = true
      unsub()
      client.disconnect()
    }
  }, [client])

  return { client }
}

export function App() {
  const forge = useForgeWindow()
  const { client } = useT3()
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState('')
  const [pairInput, setPairInput] = useState('')
  const [pairBusy, setPairBusy] = useState(false)

  const threads = client.threads
  const connection = client.connection
  const runningCount = useMemo(
    () => threads.filter((t) => t.status === 'running').length,
    [threads],
  )
  const now = useNow(runningCount > 0)
  const dockRows = Math.max(
    1,
    !client.hasCredential() || connection === 'offline' || connection === 'error'
      ? 1
      : threads.length || 1,
  )

  useEffect(() => {
    if (!forge.expanded) window.forge?.setDockRows(dockRows)
  }, [forge.expanded, dockRows])

  useEffect(() => {
    if (openId && !threads.some((t) => t.id === openId)) {
      client.closeThread()
      setOpenId(null)
    }
  }, [threads, openId, client])

  const selected = threads.find((t) => t.id === openId) ?? null

  useEffect(() => {
    if (!forge.expanded) {
      if (openId) {
        setOpenId(null)
        client.closeThread()
      }
      return
    }
    window.forge?.setPanelMode(selected ? 'chat' : 'list')
  }, [selected, forge.expanded, openId, client])

  function openThread(id: string) {
    setSendError('')
    setOpenId(id)
    client.openThread(id)
  }

  function backToList() {
    setDraft('')
    setSendError('')
    setOpenId(null)
    client.closeThread()
  }

  async function onSend() {
    if (!selected || !draft.trim() || busy) return
    setBusy(true)
    setSendError('')
    try {
      await client.sendMessage(selected.id, draft)
      setDraft('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'No se pudo enviar')
    } finally {
      setBusy(false)
    }
  }

  async function onInterrupt() {
    if (!selected || busy) return
    setBusy(true)
    setSendError('')
    try {
      await client.interrupt(selected.id)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'No se pudo interrumpir')
    } finally {
      setBusy(false)
    }
  }

  async function onPair() {
    setPairBusy(true)
    setSendError('')
    try {
      await client.pairWithCredential(pairInput)
      setPairInput('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'No se pudo emparejar')
    } finally {
      setPairBusy(false)
    }
  }

  if (!forge.expanded) {
    const unpaired = !client.hasCredential()
    const rows: Array<{
      id: string
      name: string
      status: AgentThread['status'] | 'unknown'
      label: string
      time?: string
    }> = unpaired
      ? [{ id: 'pair', name: 'Forge Eye', status: 'unknown', label: 'emparejar' }]
      : connection === 'offline' || connection === 'error'
        ? [
            {
              id: 'link',
              name: 'Forge Eye',
              status: 'error',
              label: client.lastError || 'sin enlace',
            },
          ]
        : threads.length === 0
          ? [
              {
                id: 'empty',
                name: connection === 'connecting' ? 'Conectando…' : 'Forge Eye',
                status: 'unknown',
                label: connection === 'connecting' ? '…' : 'sin hilos',
              },
            ]
          : threads.map((t) => ({
              id: t.id,
              name: t.title,
              status: t.status,
              label: statusLabel[t.status] ?? statusLabel.unknown,
              time: t.status === 'running' ? formatElapsed(t.startedAt, now) ?? '' : '',
            }))

    return (
      <div className="app">
        <div className="dock">
          {rows.map((row) => (
            <button
              key={row.id}
              className={`dock-row dock-${row.status}`}
              type="button"
              title={row.name}
              onClick={() => {
                if (row.id !== 'pair' && row.id !== 'link' && row.id !== 'empty') {
                  openThread(row.id)
                }
                forge.open()
              }}
            >
              <span className={`strip-dot strip-dot-${row.status}`} aria-hidden />
              <span className="strip-name">{row.name}</span>
              <span className={`strip-status strip-status-${row.status}`}>{row.label}</span>
              {row.time ? <span className="strip-time">{row.time}</span> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <section
          className={`panel ${forge.dragMode ? 'drag-mode' : ''} ${forge.clickThrough ? 'click-through' : ''}`}
        >
        <header className={`header ${forge.dragMode ? 'draggable' : ''}`}>
          <div className="header-start">
            {selected ? (
              <button
                className="icon-btn"
                type="button"
                title="Volver a hilos"
                onClick={backToList}
              >
                <SolarIcon name="back" size={16} />
              </button>
            ) : null}
            <div className="brand">
              <h1>{selected ? selected.title : 'Forge Eye'}</h1>
              <p>
                {selected
                  ? `${selected.projectTitle} · ${statusText(selected, now)}`
                  : 'Agentes T3'}
              </p>
            </div>
          </div>
          <div className="header-actions">
            <button
              className={`icon-btn ${forge.dragMode ? 'active' : ''}`}
              type="button"
              title="Modo mover (Ctrl+Shift+D)"
              onClick={() => forge.toggleDrag()}
            >
              <SolarIcon name="move" size={16} />
            </button>
            <button className="icon-btn" type="button" title="Cerrar" onClick={() => forge.close()}>
              <SolarIcon name="collapse" size={16} />
            </button>
          </div>
        </header>

        <div className="status-row">
          <span className="hud-badge">
            <span className={`dot ${connection}`} />
            {connectionLabel[connection]}
          </span>
          <span className="status-count">
            {forge.clickThrough ? 'clics al juego' : `${runningCount} activos`}
          </span>
        </div>

        {!client.hasCredential() ? (
          <div className="pair-box">
            <p className="pair-box-label">Enlace T3</p>
            <p>
              En T3 Code: <strong>Settings → Connections → Create Link</strong>. Pega aquí el enlace
              o el token. Si ya aparece un cliente gris (p. ej. Forge-Desu), haz{' '}
              <strong>Revoke</strong> y crea un link nuevo: ese listado no significa que Forge Eye
              esté emparejado.
            </p>
            <textarea
              value={pairInput}
              placeholder="http://127.0.0.1:3773/pair#token=… o el token"
              onChange={(e) => setPairInput(e.target.value)}
            />
            {sendError ? <div className="error-banner">{sendError}</div> : null}
            <button
              className="primary"
              type="button"
              disabled={!pairInput.trim() || pairBusy}
              onClick={() => void onPair()}
            >
              Emparejar
            </button>
          </div>
        ) : (
          <>
            {client.lastError ? <div className="error-banner">{client.lastError}</div> : null}

            {connection !== 'online' ? (
              <div className="pair-box">
                <p className="pair-box-label">Sesión guardada</p>
                <p>
                  Forge Eye ya tiene token, pero el enlace a T3 no está activo (
                  {connectionLabel[connection]}).
                </p>
                <div className="composer-btns">
                  <button
                    className="primary"
                    type="button"
                    disabled={connection === 'connecting'}
                    onClick={() => void client.connect({ force: true })}
                  >
                    Reconectar
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => client.clearCredential()}
                  >
                    Desemparejar
                  </button>
                </div>
              </div>
            ) : null}

            {selected ? (
              <>
                <Transcript
                  messages={client.messages}
                  activities={client.activities}
                  loading={client.chatLoading}
                  status={selected.status}
                  workingLine={selected.status === 'running' ? selected.lastLine : ''}
                />
                <div className="composer">
                  <textarea
                    value={draft}
                    placeholder={`Responder a “${selected.title}”…`}
                    disabled={busy || connection !== 'online'}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void onSend()
                      }
                    }}
                  />
                  <div className="composer-actions">
                    <span className="hint">{sendError || 'Enter envía · Shift+Enter salto'}</span>
                    <div className="composer-btns">
                      {selected.status === 'running' ? (
                        <button
                          className="ghost btn-with-icon"
                          type="button"
                          disabled={busy}
                          onClick={() => void onInterrupt()}
                        >
                          <SolarIcon name="stop" size={15} />
                          Parar
                        </button>
                      ) : null}
                      <button
                        className="primary btn-with-icon"
                        type="button"
                        disabled={!draft.trim() || busy || connection !== 'online'}
                        onClick={() => void onSend()}
                      >
                        <SolarIcon name="send" size={15} />
                        Enviar
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="thread-list">
                {threads.length === 0 ? (
                  <div className="empty">
                    {connection === 'online'
                      ? 'No hay hilos abiertos (unsettled) en T3.'
                      : 'Esperando enlace con T3…'}
                    {client.hasCredential() ? (
                      <>
                        {' '}
                        <button className="linkish" type="button" onClick={() => client.clearCredential()}>
                          Desemparejar
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  threads.map((t) => (
                    <ThreadRow
                      key={t.id}
                      thread={t}
                      now={now}
                      onSelect={() => openThread(t.id)}
                    />
                  ))
                )}
              </div>
            )}
          </>
        )}

        <div className="footer-keys">
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> panel
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> clics
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> mover
          </span>
        </div>
      </section>
    </div>
  )
}

function ThreadRow({
  thread,
  now,
  onSelect,
}: {
  thread: AgentThread
  now: number
  onSelect: () => void
}) {
  const time = thread.status === 'running' ? formatElapsed(thread.startedAt, now) : null
  return (
    <button type="button" className={`dock-row dock-${thread.status}`} onClick={onSelect}>
      <span className={`strip-dot strip-dot-${thread.status}`} aria-hidden />
      <span className="strip-name">{thread.title}</span>
      <span className={`strip-status strip-status-${thread.status}`}>
        {statusLabel[thread.status] ?? statusLabel.unknown}
      </span>
      {time ? <span className="strip-time">{time}</span> : null}
    </button>
  )
}

const toneLabel: Record<ActivityTone, string> = {
  tool: 'Herramienta',
  approval: 'Aprobación',
  error: 'Error',
  info: 'Actividad',
}

const toneIcon: Record<ActivityTone, 'tool' | 'approval' | 'warning' | 'info'> = {
  tool: 'tool',
  approval: 'approval',
  error: 'warning',
  info: 'info',
}

type FeedItem =
  | { key: string; at: number; kind: 'message'; message: ChatMessage }
  | { key: string; at: number; kind: 'activity'; activity: ThreadActivity }

function buildFeed(messages: ChatMessage[], activities: ThreadActivity[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const message of messages) {
    if (message.role === 'system' || !message.text.trim()) continue
    items.push({
      key: `m-${message.id}`,
      at: Date.parse(message.createdAt ?? '') || 0,
      kind: 'message',
      message,
    })
  }
  for (const activity of activities) {
    items.push({
      key: `a-${activity.id}`,
      at: Date.parse(activity.createdAt) || 0,
      kind: 'activity',
      activity,
    })
  }
  items.sort((a, b) => a.at - b.at)
  return items
}

function ActivityCard({ activity }: { activity: ThreadActivity }) {
  const body = [activity.command, activity.files.join('\n'), activity.detail]
    .filter(Boolean)
    .join('\n\n')
  const long = body.length > 500

  return (
    <div className={`activity activity-${activity.tone}`}>
      <div className="activity-head">
        <SolarIcon name={toneIcon[activity.tone]} size={14} />
        <span className="activity-kicker">{toneLabel[activity.tone]}</span>
        <span className="activity-title">{activity.title}</span>
      </div>
      {activity.command ? <pre className="activity-command">{activity.command}</pre> : null}
      {activity.files.length > 0 ? (
        <p className="activity-files">{activity.files.join('\n')}</p>
      ) : null}
      {activity.detail ? (
        long ? (
          <details>
            <summary>Ver salida completa</summary>
            <pre className="activity-detail">{activity.detail}</pre>
          </details>
        ) : (
          <pre className="activity-detail">{activity.detail}</pre>
        )
      ) : null}
    </div>
  )
}

function Transcript({
  messages,
  activities,
  loading,
  status,
  workingLine,
}: {
  messages: ChatMessage[]
  activities: ThreadActivity[]
  loading: boolean
  status: AgentThread['status']
  workingLine: string
}) {
  const feed = useMemo(() => buildFeed(messages, activities), [messages, activities])
  const scroller = useRef<HTMLDivElement>(null)
  const last = feed.at(-1)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [feed.length, last?.kind === 'message' ? last.message.text : last?.activity.detail, workingLine])

  return (
    <div className="transcript" ref={scroller}>
      {loading && feed.length === 0 ? (
        <div className="transcript-empty">Cargando conversación…</div>
      ) : feed.length === 0 ? (
        <div className="transcript-empty">
          {status === 'running' ? 'El agente está trabajando. Aún no hay texto.' : 'Sin mensajes todavía.'}
        </div>
      ) : (
        feed.map((item) =>
          item.kind === 'message' ? (
            <div key={item.key} className={`bubble bubble-${item.message.role}`}>
              <span className="bubble-role">{item.message.role === 'user' ? 'Tú' : 'Agente'}</span>
              <p>{item.message.text}</p>
            </div>
          ) : (
            <ActivityCard key={item.key} activity={item.activity} />
          ),
        )
      )}
      {status === 'running' && workingLine ? (
        <div className="activity activity-info working-line">
          <div className="activity-head">
            <SolarIcon name="info" size={14} />
            <span className="activity-kicker">Ahora</span>
            <span className="activity-title">{workingLine}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
