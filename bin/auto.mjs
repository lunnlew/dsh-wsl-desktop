/**
 * Detached helper for the WSL Desktop copy. The Host plugin spawns this script
 * so heavy work (1 GB copy, asar extraction, pnpm installs) never blocks the
 * running DSH window.
 *
 * - First initialization (no `.dsh-wsl-initialized` stamp): build the copy and
 *   sync the enabled Windows plugins into the WSL web profile once.
 * - Everything after: the environment is left alone — clicking the footer entry
 *   only launches the copy.
 *
 * @module @karoy/dsh-wsl-desktop/auto
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, setup } from '../lib/setup.js'
import { initializedFile, isInitialized, markInitialized, needsBuild, writeStatus } from '../lib/state.js'
import { spawnCopy } from '../lib/launch.js'
import { isCopyRunning, removePlugins, restartAndVerify, stopWslHost, syncPlugins } from '../lib/sync.js'

const LOCK_PATH = path.join(os.tmpdir(), 'dsh-wsl-desktop.lock')

/** Single-flight: only one helper may prepare/launch at a time. */
function acquireLock(now = Date.now()) {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
      if (prev && Number.isFinite(prev.pid) && now - (prev.at ?? 0) < 10 * 60 * 1000) {
        try {
          process.kill(prev.pid, 0)
          return false
        } catch {
          /* stale lock */
        }
      }
    }
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: now }))
    return true
  } catch {
    return true
  }
}

function releaseLock() {
  try {
    if (JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_PATH)
  } catch {
    /* ignore */
  }
}

function readConfig() {
  const source = process.argv[2]
    ? fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, '')
    : process.env.DSH_WSL_AUTO_CONFIG_FILE
      ? fs.readFileSync(process.env.DSH_WSL_AUTO_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')
      : (process.env.DSH_WSL_AUTO_CONFIG ?? '{}')
  return resolveConfig(JSON.parse(source))
}

function needsSetup(installDir) {
  return !fs.existsSync(initializedFile(installDir))
}

const config = readConfig()
const steps = []

while (!acquireLock()) {
  const sleep = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sleep, 0, 0, 3000)
}

try {
  const running = isCopyRunning(config)
  if (running) steps.push('copy already running')
  const firstInit = needsSetup(config.installDir)

  const rebuild = config.autoSetup !== false && needsBuild(config)
  if (rebuild && running) {
    steps.push('rebuild deferred: copy is running (close it, or use /wsl-desktop-setup)')
  } else if (rebuild) {
    steps.push('build: ' + config.installDir)
    setup(config)
    steps.push('build done')
  } else {
    steps.push('copy up to date')
  }

  const shouldSync = config.syncWslPlugins !== false
  if (shouldSync) {
    steps.push(firstInit ? 'first-time sync' : 'sync enabled: reconciling WSL plugins')
    const result = syncPlugins(config)
    steps.push('WSL plugins: +' + result.added.length + ' -' + result.removed.length + ' (failed ' + result.failed.length + ', skipped ' + result.skipped.length + ')')
    const changed = result.added.length > 0 || result.removed.length > 0 || result.bundlesUpdated || result.bundlesDeactivated || result.configsMerged
    if (changed && running) {
      steps.push('synced; reopen the WSL window to load the new plugins')
    } else if (changed) {
      if (restartAndVerify()) {
        steps.push('WSL Host reloaded with the synced plugins')
      } else {
        removePlugins(result.added)
        stopWslHost()
        steps.push('WSL Host failed to boot with the synced plugins; rolled back ' + String(result.added.length))
      }
    }
    markInitialized(config.installDir)
  } else {
    steps.push('sync disabled (syncWslPlugins off)')
    if (firstInit) markInitialized(config.installDir)
  }

  if (config.autoLaunch !== false) {
    // Launching while the copy already runs hits its single-instance lock and
    // focuses the existing window; that is how the footer brings an open WSL
    // window back to the foreground.
    const pid = spawnCopy(config)
    steps.push((running ? 'focused existing copy pid=' : 'launched pid=') + String(pid))
  } else {
    steps.push('copy not started (start it from the button or /wsl-desktop-launch)')
  }

  writeStatus(config.installDir, { ok: true, steps })
} catch (error) {
  writeStatus(config.installDir, { ok: false, steps, error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  releaseLock()
}