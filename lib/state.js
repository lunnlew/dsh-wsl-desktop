/**
 * State for the WSL Desktop copy: version stamp, auto-run status and the
 * "is a rebuild needed" decision.
 *
 * @module @karoy/dsh-wsl-desktop/state
 */
import fs from 'node:fs'
import path from 'node:path'

/** Bumped whenever the main.js patch changes, so an old copy is rebuilt. */
export const PATCH_VERSION = '6'

export function stampFile(installDir) {
  return path.join(installDir, '.dsh-wsl-version')
}

export function statusFile(installDir) {
  return path.join(installDir, '.dsh-wsl-auto-status.json')
}

/** The running Desktop version, injected by the shell into the Host. */
export function currentVersion() {
  return process.env.DSH_CLIENT_VERSION ?? ''
}

export function readStamp(installDir) {
  try {
    return JSON.parse(fs.readFileSync(stampFile(installDir), 'utf8'))
  } catch {
    return null
  }
}

export function writeStamp(installDir, config) {
  fs.writeFileSync(stampFile(installDir), JSON.stringify({
    version: currentVersion(),
    mode: config.mode,
    patch: PATCH_VERSION,
    at: new Date().toISOString(),
  }, null, 2))
}

/** True when the copy is missing, carries another mode, or predates this Desktop build. */
export function needsBuild(config) {
  const mainPath = path.join(config.installDir, 'resources', 'app', 'lib', 'main.js')
  if (!fs.existsSync(mainPath)) return true
  const stamp = readStamp(config.installDir)
  if (stamp === null) return true
  if (stamp.mode !== config.mode) return true
  if (stamp.patch !== PATCH_VERSION) return true
  const version = currentVersion()
  return version !== '' && stamp.version !== version
}

export function readStatus(installDir) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(installDir), 'utf8'))
  } catch {
    return null
  }
}

export function writeStatus(installDir, status) {
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(statusFile(installDir), JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2))
}
/** First-sync stamp: sync runs only once until removed. */
export function initializedFile(installDir) {
  return path.join(installDir, '.dsh-wsl-initialized')
}

export function isInitialized(installDir) {
  return fs.existsSync(initializedFile(installDir))
}

export function markInitialized(installDir) {
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(initializedFile(installDir), new Date().toISOString())
}