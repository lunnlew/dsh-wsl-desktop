/**
 * Host half of the Desktop-proxy installer plugin. By default it runs fully
 * automatically on profile load: a detached helper rebuilds the patched copy
 * when missing or the Desktop version changed, mirrors the enabled Windows
 * plugins into the WSL web profile, then launches the copy. The footer entry and
 * the slash commands are the manual fallback.
 *
 * @module @karoy/dsh-wsl-desktop
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { remove, resolveConfig, setup, status } from './lib/setup.js'
import { needsBuild, readStatus } from './lib/state.js'
import { spawnCopy } from './lib/launch.js'
import { isCopyRunning as isCopyRunningCached } from './lib/sync.js'
import { hostState, stopWslHost, syncPlugins } from './lib/sync.js'
import { enableWslTerminal } from './lib/sync.js'
import { doctor } from './lib/doctor.js'

export const inject = ['commands', 'webServer']

/**
 * Row configuration, editable from the Plugins page (settings namespace
 * `wsl-desktop`). The profile patch supplies the defaults below; a saved edit
 * restarts this plugin, so `apply` re-reads the new values.
 */
export const Config = z.object({
  mode: z.union([z.const('proxy'), z.const('direct')]).default('proxy'),
  port: z.number().default(3080),
  distro: z.string().default(''),
  autoInstall: z.boolean().default(true),
  autoRun: z.boolean().default(true),
  autoSetup: z.boolean().default(true),
  autoLaunch: z.boolean().default(false),
  syncWslPlugins: z.boolean().default(true),
  syncLinked: z.boolean().default(false),
  autoDelayMs: z.number().default(4000),
  installDir: z.string().default(''),
  userDataDirName: z.string().default('DeepSeek Harness WSL'),
})

let scheduled = false
let runningCache = { at: 0, value: false }

/** Cached isCopyRunning (PowerShell probe is not free; poll asks every few seconds). */
/** True when the running copy proved it booted against the WSL Host (marker written by its patched main.js). */
function copyWslMode(config) {
  try {
    const file = path.join(config.installDir, '.dsh-wsl-running.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data === null || data.mode !== 'proxy') return false
    if (Number.isFinite(data.pid)) {
      try { process.kill(data.pid, 0) } catch { return false }
    }
    const at = Date.parse(data.at ?? '')
    if (Number.isFinite(at) && Date.now() - at > 24 * 60 * 60 * 1000) return false
    return true
  } catch {
    return false
  }
}

function copyRunning(config) {
  const now = Date.now()
  if (now - runningCache.at < 5000) return runningCache.value
  let value = false
  try { value = isCopyRunningCached(config) } catch { value = false }
  runningCache = { at: now, value }
  return value
}

function failure(error) {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

function helperPath() {
  return fileURLToPath(new URL('./bin/auto.mjs', import.meta.url))
}

/** Spawn the detached auto-run helper (build/sync/launch) once per Host lifetime. */
function scheduleAutoRun(config) {
  if (scheduled) return
  scheduled = true
  runHelper(config)
}

/** Read a JSON request body, bounded to 1 MiB. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        const error = new Error('request body too large')
        error.statusCode = 413
        req.destroy()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Keys the DSH settings page may edit (the Config schema's fields). */
export const CONFIG_KEYS = Object.keys(Config({}))

const TERMINAL_BUNDLE = '@deepseek-ai/dsh-experimental-terminal-bundle'

/** Answer with JSON, once. */
function jsonResponse(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Decode a wsl.exe buffer: WSL writes UTF-16LE on Windows. */
function decodeWsl(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
  return data.toString('utf16le').replace(/^\uFEFF/, '')
}

/**
 * Installed WSL distros from `wsl.exe -l -v` (`-l -q` fallback for old WSL).
 * @returns Array<{ name, state, default }>.
 */
function listDistros() {
  const detailed = spawnSync('wsl.exe', ['-l', '-v'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const rows = []
  for (const line of decodeWsl(detailed.stdout).split(/\r?\n/)) {
    const match = /^(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
    if (match !== null) rows.push({ name: match[2], state: match[3], default: match[1] === '*' })
  }
  if (rows.length > 0) return rows
  const plain = spawnSync('wsl.exe', ['-l', '-q'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  return decodeWsl(plain.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name !== '')
    .map((name) => ({ name, state: 'unknown', default: false }))
}

/** The port this Host was started with (`--port N` in its argv). */
function hostPort() {
  const index = process.argv.indexOf('--port')
  if (index !== -1) {
    const value = Number(process.argv[index + 1])
    if (Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

function wslProfilePath() {
  return path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json')
}

function readWslProfile() {
  try {
    return JSON.parse(fs.readFileSync(wslProfilePath(), 'utf8'))
  } catch {
    return null
  }
}

function wslTerminalEnabled() {
  const manifest = readWslProfile()
  return (manifest?.dsh?.profile?.bundles ?? []).includes(TERMINAL_BUNDLE)
}

/** Add the terminal bundle to the WSL web profile; true when it changed. */
function enableTerminalInProfile() {
  const manifest = readWslProfile()
  if (manifest === null) throw new Error('无法读取 WSL profile：' + wslProfilePath())
  const profile = manifest.dsh ?? (manifest.dsh = {})
  const meta = profile.profile ?? (profile.profile = {})
  const bundles = meta.bundles ?? (meta.bundles = [])
  if (bundles.includes(TERMINAL_BUNDLE)) return false
  bundles.push(TERMINAL_BUNDLE)
  fs.writeFileSync(wslProfilePath(), JSON.stringify(manifest, null, 2) + '\n')
  return true
}

/**
 * The WSL side of the plugin: what the Host running *inside* WSL can do about
 * itself. There is no copy to open here and restarting this Host from inside it
 * is pointless, so it exposes its own state and the shell (terminal) toggle.
 * @param ctx - the plugin context (commands + webServer).
 */
function applyWslSide(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/wsl-state',
    handler: (req, res) => {
      if (req.method !== 'GET') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return jsonResponse(res, 200, {
        ok: true,
        mode: 'wsl',
        pid: process.pid,
        port: hostPort(),
        home: os.homedir(),
        envFile: fs.existsSync(path.join(os.homedir(), '.dsh', '.env')),
        credentials: fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml')),
        terminal: wslTerminalEnabled(),
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/wsl-shell',
    handler: (req, res) => {
      if (req.method !== 'POST') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const added = enableTerminalInProfile()
        return jsonResponse(res, 200, { ok: true, terminal: true, added, reopen: added })
      } catch (error) {
        return jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.commands.register({
    name: 'wsl-shell',
    description: 'Enable the WSL shell tabs (terminal bundle) in this window',
    handler: async () => {
      try {
        const added = enableTerminalInProfile()
        return { kind: 'success', text: added ? '已启用终端 bundle；重开这个 WSL 窗口后，右侧栏会出现 shell 标签。' : '终端已启用：右侧栏的终端标签就是 WSL 里的 shell。' }
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** Resolve the live config as a plain object (volatile accessors unwrapped). */
function liveConfig(config) {
  const plain = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
  return Object.fromEntries(Object.entries(resolveConfig(config)).map(([key, value]) => [key, plain(value)]))
}

/** Force a helper run (footer button / manual route). */
function runHelper(config) {
  // Detached + CREATE_NO_WINDOW: no console flash, survives the Host, and the
  // helper takes its config from a file argument (verified on this machine).
  const dir = path.join(os.tmpdir(), 'dsh-wsl-desktop-auto')
  fs.mkdirSync(dir, { recursive: true })
  const configFile = path.join(dir, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify(config))
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  }
  delete env.DSH_WSL_DESKTOP
  const child = spawn(process.execPath, [helperPath(), configFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  if (child.pid !== undefined) child.unref()
}

/**
 * Register automation, the footer route and the manual fallback commands.
 * @param config - `{ installDir, userDataDirName, port, distro, autoInstall, mode, autoRun, autoSetup, autoLaunch, syncWslPlugins, syncLinked, autoDelayMs }`.
 */
export function apply(ctx, config = {}) {
  const mode = process.platform === 'win32' ? 'windows' : 'wsl'
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/mode',
    handler: (req, res) => {
      if (req.method !== 'GET') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return jsonResponse(res, 200, { ok: true, platform: process.platform, mode, pid: process.pid, port: hostPort() })
    },
  }))

  if (mode === 'wsl') {
    applyWslSide(ctx)
    return
  }

  const cfg = resolveConfig(config)

  if (cfg.autoRun !== false && process.env.DSH_WSL_DESKTOP !== '1') {
    setTimeout(() => {
      try {
        scheduleAutoRun(cfg)
      } catch (error) {
        console.error('[wsl-desktop] auto-run failed', error)
      }
    }, cfg.autoDelayMs ?? 4000)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/state',
    handler: (req, res) => {
      const send = (status, body) => {
        if (res.headersSent) return
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed' })
      try {
        return send(200, {
          ok: true,
          running: copyRunning(cfg),
          wslMode: copyWslMode(cfg),
          auto: readStatus(cfg.installDir),
          needsBuild: needsBuild(cfg),
        })
      } catch (error) {
        return send(200, { ok: true, running: false, wslMode: false, auto: null, needsBuild: true })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/distros',
    handler: (req, res) => {
      if (req.method !== 'GET') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const current = resolveConfig(config).distro ?? ''
        const distros = listDistros().map((distro) => ({ ...distro, current: distro.name === current }))
        return jsonResponse(res, 200, { ok: true, current, distros })
      } catch (error) {
        return jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/select',
    handler: (req, res) => {
      if (req.method !== 'POST') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      if (req.headers['sec-fetch-site'] === 'cross-site') return jsonResponse(res, 403, { ok: false, error: 'cross-site request refused' })
      readJsonBody(req).then(async (body) => {
        try {
          const distro = typeof body?.distro === 'string' ? body.distro.trim() : null
          if (distro === null) return jsonResponse(res, 400, { ok: false, error: 'distro must be a string' })
          if (distro !== '' && !listDistros().some((item) => item.name === distro)) {
            return jsonResponse(res, 400, { ok: false, error: 'unknown WSL distro: ' + distro })
          }
          const editor = ctx.get('configEditor')
          const entry = ctx.fiber?.entry
          if (editor === undefined || entry === undefined) {
            return jsonResponse(res, 501, { ok: false, error: 'config editor unavailable in this profile' })
          }
          await editor.edit(entry, (current) => ({ ...(current ?? {}), distro }))
          runHelper({ ...resolveConfig(config), distro, autoLaunch: true, syncWslPlugins: true })
          return jsonResponse(res, 200, { ok: true, at: new Date().toISOString() })
        } catch (error) {
          return jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }, (error) => jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }))
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/config',
    handler: (req, res) => {
      const send = (status, body) => {
        if (res.headersSent) return
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method === 'GET') {
          return send(200, { ok: true, config: liveConfig(config) })
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
        readJsonBody(req).then(async (patch) => {
          try {
            for (const key of Object.keys(patch)) {
              if (!CONFIG_KEYS.includes(key)) return send(400, { ok: false, error: 'unknown config key: ' + key })
            }
            const merged = { ...resolveConfig(config), ...patch }
            try {
              Config(merged)
            } catch (validationError) {
              return send(400, { ok: false, error: 'invalid config value: ' + String(validationError instanceof Error ? validationError.message : validationError) })
            }
            const editor = ctx.get('configEditor')
            const entry = ctx.fiber?.entry
            if (editor === undefined || entry === undefined) {
              return send(501, { ok: false, error: 'config editor unavailable in this profile' })
            }
            // Persist only the edited fields; untouched fields keep their
            // defaults, so `installDir` stays empty unless the user sets it.
            await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }))
            return send(200, { ok: true, config: merged })
          } catch (error) {
            return send(Number(error?.statusCode) || 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }, (error) => {
          return send(Number(error?.statusCode) || 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      } catch (error) {
        return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/doctor',
    handler: (req, res) => {
      if (req.method !== 'GET') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const report = doctor(cfg)
        return jsonResponse(res, 200, { ok: report.ok, checks: report.checks })
      } catch (error) {
        return jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wsl-desktop/open',
    handler: (req, res) => {
      const send = (status, body) => {
        if (res.headersSent) return
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST' && req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed' })
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { ok: false, error: 'cross-site request refused' })
      try {
        runHelper({ ...cfg, autoLaunch: true, syncWslPlugins: true })
        return send(200, { ok: true, at: new Date().toISOString() })
      } catch (error) {
        return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.commands.register({
    name: 'wsl-desktop-setup',
    description: 'Rebuild the WSL Desktop proxy copy (manual fallback)',
    handler: async () => {
      try {
        return { kind: 'success', text: setup(cfg) }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-status',
    description: 'Report the WSL Desktop copy, the WSL Host state and the last auto-run',
    handler: async () => {
      try {
        const auto = readStatus(cfg.installDir)
        const lines = [status(cfg), needsBuild(cfg) ? '需要重建（版本/模式变化或副本缺失）' : '已是最新']
        const host = hostState()
        if (host.alive) {
          const started = host.startedAt > 0 ? new Date(host.startedAt * 1000).toLocaleString() : '未知'
          lines.push(
            'WSL Host: 运行中 pid=' + host.pid + ' 端口=' + (host.port === '' ? '?' : host.port) + '，启动于 ' + started,
            host.stale
              ? 'WSL Host: 配置/凭据比它新——下次打开窗口会重启它（也可 /wsl-desktop-restart 立即停掉）'
              : 'WSL Host: 与当前配置一致',
          )
        } else {
          lines.push('WSL Host: 未运行（下次打开窗口会启动）')
        }
        if (auto !== null) lines.push('auto: ' + JSON.stringify(auto.steps), auto.ok ? 'auto: ok' : 'auto 失败：' + String(auto.error))
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-doctor',
    description: 'Check the WSL Host, the configuration sources, provider keys and the package store',
    handler: async () => {
      try {
        const report = doctor(cfg)
        const mark = (state) => (state === 'ok' ? '✓' : state === 'warn' ? '!' : '✗')
        const lines = report.checks.map((check) => mark(check.state) + ' ' + check.name + ': ' + check.detail)
        return { kind: report.ok ? 'success' : 'error', text: lines.join('\n') }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-restart',
    description: 'Stop the WSL Host so the next open starts it with the current env/profile/credentials',
    handler: async () => {
      try {
        const result = stopWslHost()
        if (result.out.includes('STOPPED')) {
          return { kind: 'success', text: '已停止 WSL Host；下次「从WSL打开」会用最新的 .env / profile patch / 凭据启动。已打开的 WSL 窗口会断开，需要重开。' }
        }
        return { kind: 'success', text: 'WSL Host 当前没有运行，下次打开会直接启动。' }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-terminal',
    description: 'Enable interactive shell tabs (the official terminal bundle) in the WSL desktop window',
    handler: async () => {
      try {
        const result = enableWslTerminal()
        if (result.missing) {
          return { kind: 'error', text: 'WSL 里的 DSH 安装不包含 @deepseek-ai/dsh-experimental-terminal-bundle（DSH 版本太旧？）' }
        }
        if (result.added) {
          stopWslHost()
          return { kind: 'success', text: '已在 WSL profile 启用终端 bundle，并停止了 WSL Host。重新「从WSL打开」后，窗口右侧栏会出现终端标签，跑的是 WSL 里的 shell。' }
        }
        return { kind: 'success', text: '终端 bundle 已经启用；如果窗口里没看到终端标签，重开一次 WSL 窗口即可。' }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-launch',
    description: 'Launch the WSL Desktop proxy copy now',
    handler: async () => {
      try {
        return { kind: 'success', text: '已启动，pid=' + String(spawnCopy(cfg)) }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-sync',
    description: 'Mirror the enabled Windows desktop profile plugins into the WSL web profile',
    handler: async () => {
      try {
        const result = syncPlugins(cfg)
        return {
          kind: 'success',
          text: ['added: ' + result.added.join(', '), 'removed: ' + result.removed.join(', '), 'failed: ' + result.failed.join(', '), 'skipped: ' + result.skipped.map((s) => s.name + ' (' + s.reason + ')').join(', ')].join('\n'),
        }
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.commands.register({
    name: 'wsl-desktop-remove',
    description: 'Remove the WSL Desktop copy and its isolated Electron profile',
    handler: async () => {
      try {
        return { kind: 'success', text: remove(cfg) }
      } catch (error) {
        return failure(error)
      }
    },
  })
}