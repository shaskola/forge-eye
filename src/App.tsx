import { useEffect, useMemo, useRef, useState } from 'react'
import { SolarIcon } from './icons/SolarIcon'
import { useSettings } from './i18n/SettingsContext'
import { formatStoredError, formatUnknownError } from './i18n/errors'
import type { MsgKey } from './i18n/catalog'
import { T3Client, type AgentThread, type ChatMessage, type ConnectionState, type ThreadActivity } from './t3/client'
import type { ActivityTone } from './t3/activity'

function RefreshButton({
  busy,
  disabled,
  onClick,
  label,
  busyLabel,
  title,
}: {
  busy: boolean
  disabled: boolean
  onClick: () => void
  label?: string
  busyLabel: string
  title: string
}) {
  return (
    <button
      className={label ? 'dock-row dock-action' : 'icon-btn'}
      type="button"
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <SolarIcon name="refresh" size={16} className={busy ? 'is-spinning' : undefined} />
      {label ? <span className="strip-name">{busy ? busyLabel : label}</span> : null}
    </button>
  )
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

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function useForgeWindow() {
  const [expanded, setExpanded] = useState(true)
  const [dragMode, setDragMode] = useState(false)
  const [clickThrough, setClickThrough] = useState(true)

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
  const { t, locale, opacity, setOpacity, setLocale } = useSettings()
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState('')
  const [pairInput, setPairInput] = useState('')
  const [pairBusy, setPairBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const statusLabel = (status: string) => {
    if (status === 'idle') return t('statusIdle')
    if (status === 'running') return t('statusRunning')
    if (status === 'error') return t('statusError')
    return t('statusUnknown')
  }

  const connectionLabel = (state: ConnectionState) => {
    if (state === 'needs_pair') return t('connNeedsPair')
    if (state === 'connecting') return t('connConnecting')
    if (state === 'online') return t('connOnline')
    if (state === 'offline') return t('connOffline')
    return t('connError')
  }

  const threadTitle = (thread: Pick<AgentThread, 'title'>) => thread.title || t('fallbackThread')
  const threadLine = (thread: Pick<AgentThread, 'lastLine' | 'lastLineKey'>) =>
    thread.lastLine || (thread.lastLineKey ? t(thread.lastLineKey) : '')
  const statusText = (thread: Pick<AgentThread, 'status' | 'startedAt'>, now: number) => {
    if (thread.status !== 'running') return statusLabel(thread.status)
    return formatElapsed(thread.startedAt, now) ?? t('statusRunning')
  }
  const fail = (err: unknown, fallback: MsgKey) => formatUnknownError(locale, err, fallback)
  const storedError = formatStoredError(locale, client.lastErrorKey, client.lastErrorParams, client.lastErrorRaw)

  const threads = client.threads
  const connection = client.connection
  const runningCount = useMemo(
    () => threads.filter((row) => row.status === 'running').length,
    [threads],
  )
  const now = useNow(runningCount > 0 || refreshing)
  const canRefresh = client.hasCredential() && connection !== 'needs_pair'
  const extraDockRows = canRefresh ? 1 : 0
  const dockRows = Math.max(
    1,
    !client.hasCredential() || connection === 'offline' || connection === 'error'
      ? 1 + extraDockRows
      : (threads.length || 1) + extraDockRows,
  )

  useEffect(() => {
    if (!forge.expanded) window.forge?.setDockRows(dockRows)
  }, [forge.expanded, dockRows])

  useEffect(() => {
    if (openId && !threads.some((row) => row.id === openId)) {
      client.closeThread()
      setOpenId(null)
    }
  }, [threads, openId, client])

  const selected = threads.find((row) => row.id === openId) ?? null

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

  async function onRefresh() {
    if (refreshing || !canRefresh) return
    setRefreshing(true)
    setSendError('')
    try {
      await client.refresh()
    } catch (err) {
      setSendError(fail(err, 'errorRefresh'))
    } finally {
      setRefreshing(false)
    }
  }

  async function onSend() {
    if (!selected || !draft.trim() || busy) return
    setBusy(true)
    setSendError('')
    try {
      await client.sendMessage(selected.id, draft)
      setDraft('')
    } catch (err) {
      setSendError(fail(err, 'errorSend'))
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
      setSendError(fail(err, 'errorInterrupt'))
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
      setSendError(fail(err, 'errorPair'))
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
      ? [{ id: 'pair', name: 'Forge Eye', status: 'unknown', label: t('pairDockLabel') }]
      : connection === 'offline' || connection === 'error'
        ? [
            {
              id: 'link',
              name: 'Forge Eye',
              status: 'error',
              label: storedError || t('noLink'),
            },
          ]
        : threads.length === 0
          ? [
              {
                id: 'empty',
                name: connection === 'connecting' ? t('connectingName') : 'Forge Eye',
                status: 'unknown',
                label: connection === 'connecting' ? '…' : t('noThreads'),
              },
            ]
          : threads.map((row) => ({
              id: row.id,
              name: threadTitle(row),
              status: row.status,
              label: statusLabel(row.status),
              time: row.status === 'running' ? formatElapsed(row.startedAt, now) ?? '' : '',
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
          {canRefresh ? (
            <RefreshButton
              busy={refreshing}
              disabled={connection === 'connecting'}
              onClick={() => void onRefresh()}
              label={t('refresh')}
              busyLabel={t('refreshing')}
              title={t('refreshTitle')}
            />
          ) : null}
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
                title={t('backToThreads')}
                onClick={backToList}
              >
                <SolarIcon name="back" size={16} />
              </button>
            ) : null}
            <div className="brand">
              <h1>{selected ? threadTitle(selected) : 'Forge Eye'}</h1>
              <p>
                {selected
                  ? `${selected.projectTitle || t('fallbackProject')} · ${statusText(selected, now)}`
                  : t('brandSubtitle')}
              </p>
            </div>
          </div>
          <div className="header-actions">
            {canRefresh ? (
              <RefreshButton
                busy={refreshing}
                disabled={connection === 'connecting'}
                onClick={() => void onRefresh()}
                busyLabel={t('refreshing')}
                title={t('refreshTitle')}
              />
            ) : null}
            <button
              className={`icon-btn ${settingsOpen ? 'active' : ''}`}
              type="button"
              title={t('settings')}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SolarIcon name="settings" size={16} />
            </button>
            <button
              className={`icon-btn ${forge.dragMode ? 'active' : ''}`}
              type="button"
              title={t('moveMode')}
              onClick={() => forge.toggleDrag()}
            >
              <SolarIcon name="move" size={16} />
            </button>
            <button className="icon-btn" type="button" title={t('close')} onClick={() => forge.close()}>
              <SolarIcon name="collapse" size={16} />
            </button>
          </div>
        </header>

        {settingsOpen ? (
          <div className="settings-bar">
            <label className="settings-row" htmlFor="overlay-opacity">
              {t('opacity')}
              <input
                id="overlay-opacity"
                type="range"
                min={25}
                max={100}
                step={1}
                value={Math.round(opacity * 100)}
                onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              />
              <span className="settings-value">{Math.round(opacity * 100)}%</span>
            </label>
            <div className="settings-row">
              {t('language')}
              <div className="locale-toggle" role="group" aria-label={t('language')}>
                <button
                  type="button"
                  className={locale === 'en' ? 'active' : ''}
                  onClick={() => setLocale('en')}
                >
                  {t('langEnglish')}
                </button>
                <button
                  type="button"
                  className={locale === 'es' ? 'active' : ''}
                  onClick={() => setLocale('es')}
                >
                  {t('langSpanish')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="status-row">
          <span className="hud-badge">
            <span className={`dot ${connection}`} />
            {connectionLabel(connection)}
          </span>
          <div className="status-row-end">
            <span className="status-count">
              {forge.clickThrough
                ? t('clicksToGame')
                : forge.dragMode
                  ? t('moveThePanel')
                  : t('statusCountActive', { count: runningCount })}
            </span>
            {canRefresh ? (
              <button
                className="refresh-text-btn"
                type="button"
                title={t('refreshTitle')}
                disabled={refreshing || connection === 'connecting'}
                onClick={() => void onRefresh()}
              >
                <SolarIcon name="refresh" size={14} className={refreshing ? 'is-spinning' : undefined} />
                {refreshing ? t('refreshing') : t('refresh')}
              </button>
            ) : null}
          </div>
        </div>

        {!client.hasCredential() ? (
          <div className="pair-box">
            <p className="pair-box-label">{t('pairHeading')}</p>
            <p>{t('pairBody')}</p>
            <textarea
              value={pairInput}
              placeholder={t('pairPlaceholder')}
              onChange={(e) => setPairInput(e.target.value)}
            />
            {sendError ? <div className="error-banner">{sendError}</div> : null}
            <button
              className="primary"
              type="button"
              disabled={!pairInput.trim() || pairBusy}
              onClick={() => void onPair()}
            >
              {t('pairButton')}
            </button>
          </div>
        ) : (
          <>
            {storedError ? <div className="error-banner">{storedError}</div> : null}

            {connection !== 'online' ? (
              <div className="pair-box">
                <p className="pair-box-label">{t('savedSession')}</p>
                <p>{t('savedSessionBody', { status: connectionLabel(connection) })}</p>
                <div className="composer-btns">
                  <button
                    className="primary"
                    type="button"
                    disabled={connection === 'connecting'}
                    onClick={() => void client.connect({ force: true })}
                  >
                    {t('reconnect')}
                  </button>
                  <button className="ghost" type="button" onClick={() => client.clearCredential()}>
                    {t('unpair')}
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
                  workingLine={selected.status === 'running' ? threadLine(selected) : ''}
                />
                <div className="composer">
                  <textarea
                    value={draft}
                    placeholder={t('replyPlaceholder', { title: threadTitle(selected) })}
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
                    <span className="hint">{sendError || t('composerHint')}</span>
                    <div className="composer-btns">
                      {selected.status === 'running' ? (
                        <button
                          className="ghost btn-with-icon"
                          type="button"
                          disabled={busy}
                          onClick={() => void onInterrupt()}
                        >
                          <SolarIcon name="stop" size={15} />
                          {t('stop')}
                        </button>
                      ) : null}
                      <button
                        className="primary btn-with-icon"
                        type="button"
                        disabled={!draft.trim() || busy || connection !== 'online'}
                        onClick={() => void onSend()}
                      >
                        <SolarIcon name="send" size={15} />
                        {t('send')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="thread-list">
                {threads.length === 0 ? (
                  <div className="empty">
                    {connection === 'online' ? t('emptyUnsettled') : t('waitingT3')}
                    {client.hasCredential() ? (
                      <>
                        {' '}
                        <button className="linkish" type="button" onClick={() => client.clearCredential()}>
                          {t('unpair')}
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  threads.map((row) => (
                    <ThreadRow
                      key={row.id}
                      thread={row}
                      now={now}
                      onSelect={() => openThread(row.id)}
                    />
                  ))
                )}
              </div>
            )}
          </>
        )}

        <div className="footer-keys">
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> {t('footerHide')}
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> {t('footerPanel')}
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> {t('footerClick')}
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> {t('footerMove')}
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
  const { t } = useSettings()
  const time = thread.status === 'running' ? formatElapsed(thread.startedAt, now) : null
  const statusLabel =
    thread.status === 'idle'
      ? t('statusIdle')
      : thread.status === 'running'
        ? t('statusRunning')
        : thread.status === 'error'
          ? t('statusError')
          : t('statusUnknown')
  return (
    <button type="button" className={`dock-row dock-${thread.status}`} onClick={onSelect}>
      <span className={`strip-dot strip-dot-${thread.status}`} aria-hidden />
      <span className="strip-name">{thread.title || t('fallbackThread')}</span>
      <span className={`strip-status strip-status-${thread.status}`}>{statusLabel}</span>
      {time ? <span className="strip-time">{time}</span> : null}
    </button>
  )
}

const toneKey: Record<ActivityTone, MsgKey> = {
  tool: 'toneTool',
  approval: 'toneApproval',
  error: 'toneError',
  info: 'toneInfo',
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
  const { t } = useSettings()
  const body = [activity.command, activity.files.join('\n'), activity.detail]
    .filter(Boolean)
    .join('\n\n')
  const long = body.length > 500

  return (
    <div className={`activity activity-${activity.tone}`}>
      <div className="activity-head">
        <SolarIcon name={toneIcon[activity.tone]} size={14} />
        <span className="activity-kicker">{t(toneKey[activity.tone])}</span>
        <span className="activity-title">{activity.title}</span>
      </div>
      {activity.command ? <pre className="activity-command">{activity.command}</pre> : null}
      {activity.files.length > 0 ? (
        <p className="activity-files">{activity.files.join('\n')}</p>
      ) : null}
      {activity.detail ? (
        long ? (
          <details>
            <summary>{t('seeFullOutput')}</summary>
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
  const { t } = useSettings()
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
        <div className="transcript-empty">{t('loadingChat')}</div>
      ) : feed.length === 0 ? (
        <div className="transcript-empty">
          {status === 'running' ? t('agentWorkingNoText') : t('noMessagesYet')}
        </div>
      ) : (
        feed.map((item) =>
          item.kind === 'message' ? (
            <div key={item.key} className={`bubble bubble-${item.message.role}`}>
              <span className="bubble-role">{item.message.role === 'user' ? t('you') : t('agent')}</span>
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
            <span className="activity-kicker">{t('now')}</span>
            <span className="activity-title">{workingLine}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
