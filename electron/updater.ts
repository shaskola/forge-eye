import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const REPO = 'shaskola/forge-eye'
const PORTABLE_NAME = /^ForgeEye-Portable-\d+\.\d+\.\d+\.exe$/
const PORTABLE_DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`

export type UpdateState =
  | 'dev'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unavailable'
  | 'error'

export type UpdateStatus = {
  state: UpdateState
  version: string
  nextVersion?: string
  percent?: number
  error?: string
}

let status: UpdateStatus = {
  state: 'idle',
  version: app.getVersion(),
}
let getWindow: () => BrowserWindow | null = () => null
let portableDownloadPath: string | null = null

function publish() {
  getWindow()?.webContents.send('forge:update', status)
}

function setStatus(patch: Partial<UpdateStatus>) {
  status = { ...status, version: app.getVersion(), ...patch }
  publish()
}

function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
}

function portableTargetPath() {
  const file = process.env.PORTABLE_EXECUTABLE_FILE
  if (file && file.toLowerCase().endsWith('.exe')) return file
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  if (dir) return path.join(dir, path.basename(file || 'ForgeEye-Portable.exe'))
  return null
}

function isNewer(remote: string, local: string) {
  const parse = (value: string) =>
    value
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(remote)
  const b = parse(local)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, version: app.getVersion() }
}

export function setupAutoUpdate(getWin: () => BrowserWindow | null) {
  getWindow = getWin
  status.version = app.getVersion()

  ipcMain.handle('forge:get-update', () => getUpdateStatus())
  ipcMain.on('forge:check-update', () => {
    void checkForUpdates()
  })
  ipcMain.on('forge:install-update', () => {
    if (status.state !== 'ready') return
    if (isPortable()) {
      applyPortableUpdate()
      return
    }
    autoUpdater.quitAndInstall(false, true)
  })

  if (!app.isPackaged) {
    setStatus({ state: 'dev' })
    return
  }

  if (!isPortable()) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.on('checking-for-update', () => {
      setStatus({ state: 'checking' })
    })
    autoUpdater.on('update-available', (info) => {
      setStatus({ state: 'available', nextVersion: info.version })
    })
    autoUpdater.on('update-not-available', () => {
      setStatus({ state: 'unavailable', nextVersion: undefined, percent: undefined })
    })
    autoUpdater.on('download-progress', (progress) => {
      setStatus({
        state: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      setStatus({ state: 'ready', nextVersion: info.version, percent: 100 })
    })
    autoUpdater.on('error', (err) => {
      setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    })
  }

  setTimeout(() => {
    void checkForUpdates()
  }, 12000)
}

async function checkForUpdates() {
  if (!app.isPackaged) return
  if (isPortable()) {
    await checkPortableUpdate()
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

type GithubAsset = {
  name?: string
  browser_download_url?: string
  size?: number
  digest?: string
}

type GithubRelease = {
  tag_name?: string
  assets?: GithubAsset[]
}

async function checkPortableUpdate() {
  const target = portableTargetPath()
  if (!target) {
    setStatus({ state: 'error', error: 'missing portable path' })
    return
  }

  setStatus({ state: 'checking', error: undefined, percent: undefined })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Forge-Eye',
      },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const release = (await res.json()) as GithubRelease
    const remoteVersion = String(release.tag_name ?? '').replace(/^v/i, '')
    if (!remoteVersion || !isNewer(remoteVersion, app.getVersion())) {
      setStatus({ state: 'unavailable', nextVersion: undefined, percent: undefined })
      return
    }

    const asset = (release.assets ?? []).find(
      (item) =>
        typeof item.name === 'string' &&
        PORTABLE_NAME.test(item.name) &&
        typeof item.browser_download_url === 'string' &&
        item.browser_download_url.startsWith(PORTABLE_DOWNLOAD_PREFIX),
    )
    if (!asset?.browser_download_url || !asset.name) {
      throw new Error('portable asset missing')
    }

    setStatus({ state: 'available', nextVersion: remoteVersion })
    const dest = path.join(app.getPath('temp'), asset.name)
    await downloadFile(asset.browser_download_url, dest, asset.size, asset.digest)
    portableDownloadPath = dest
    setStatus({ state: 'ready', nextVersion: remoteVersion, percent: 100 })
  } catch (err) {
    portableDownloadPath = null
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function downloadFile(url: string, dest: string, expectedSize?: number, digest?: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Forge-Eye' },
    redirect: 'follow',
  })
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`)

  const total = Number(res.headers.get('content-length') || expectedSize || 0)
  const hash = crypto.createHash('sha256')
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    hash.update(chunk)
    if (total > 0) {
      setStatus({
        state: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round((received / total) * 100))),
      })
    }
  })
  await pipeline(nodeStream, fs.createWriteStream(dest))

  if (expectedSize && expectedSize > 0 && received !== expectedSize) {
    throw new Error('download size mismatch')
  }
  const expectedHash = digest?.startsWith('sha256:') ? digest.slice('sha256:'.length).toLowerCase() : ''
  if (expectedHash && hash.digest('hex') !== expectedHash) {
    throw new Error('download hash mismatch')
  }
}

function psQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function applyPortableUpdate() {
  const src = portableDownloadPath
  const dst = portableTargetPath()
  if (!src || !dst || !src.toLowerCase().endsWith('.exe') || !dst.toLowerCase().endsWith('.exe')) {
    return
  }
  if (!fs.existsSync(src)) return

  const script = path.join(app.getPath('temp'), 'forge-eye-apply-portable.ps1')
  fs.writeFileSync(
    script,
    [
      '$ErrorActionPreference = "Continue"',
      `$src = ${psQuote(src)}`,
      `$dst = ${psQuote(dst)}`,
      'for ($i = 0; $i -lt 30; $i++) {',
      '  Start-Sleep -Seconds 1',
      '  try {',
      '    Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop',
      '    break',
      '  } catch {}',
      '}',
      'Start-Process -FilePath $dst',
      'Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue',
      'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
      '',
    ].join('\r\n'),
    'utf8',
  )

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { detached: true, stdio: 'ignore', windowsHide: true },
  )
  child.unref()
  app.quit()
}
