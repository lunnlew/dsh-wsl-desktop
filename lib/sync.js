/**
 * Mirror the complete plugin state of the Windows desktop profile into the WSL
 * web profile: enabled plugins are installed and enabled, disabled ones are
 * installed but kept disabled, and their profile config rows (id/name/enabled/
 * config) are carried over with the same enable state.
 *
 * This runs once during the first initialization (and on demand via
 * `/wsl-desktop-sync`); afterwards the WSL side is authoritative.
 *
 * `link:` packages are skipped unless `syncLinked` is set.
 *
 * @module @karoy/dsh-wsl-desktop/sync
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergePluginConfigs } from './merge-patch.js'

const SKIP = [/^@deepseek-ai\//]

function wsl(script, timeoutMs = 900000) {
  const result = spawnSync('wsl.exe', ['--', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return { ok: result.status === 0, out: String(result.stdout ?? '') + String(result.stderr ?? '') }
}

/**
 * Run a script that starts the WSL Host under an interactive login shell, so
 * ~/.bashrc / ~/.profile (and the Host's ~/.dsh/.env at boot) apply.
 */
function wslHost(script, timeoutMs = 180000) {
  const result = spawnSync('wsl.exe', ['--', 'bash', '-lis'], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return { ok: result.status === 0, out: String(result.stdout ?? '') + String(result.stderr ?? '') }
}

/** Run a script in an interactive login shell and keep only stdout.
 *  `bash -is` echoes the commands to stderr, which would otherwise be mistaken
 *  for our ADD_OK/ADD_FAIL markers. */
function wslLoginOut(script, timeoutMs = 900000) {
  const result = spawnSync('wsl.exe', ['--', 'bash', '-lis'], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return { ok: result.status === 0, out: String(result.stdout ?? '') }
}

export function toWslPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  return match === null ? value : '/mnt/' + match[1].toLowerCase() + '/' + match[2].replaceAll('\\', '/')
}

export function readWindowsProfile() {
  const manifest = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
  if (!fs.existsSync(manifest)) return { dependencies: {}, bundles: [] }
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  return { dependencies: data.dependencies ?? {}, bundles: data.dsh?.profile?.bundles ?? [] }
}

export function readWslManifest() {
  const result = wsl('cat "$HOME/.dsh/profiles/web/package.json"', 30000)
  const start = result.out.indexOf('{')
  if (start === -1) return { bundles: [], dependencies: {} }
  try {
    const manifest = JSON.parse(result.out.slice(start))
    return { bundles: manifest.dsh?.profile?.bundles ?? [], dependencies: manifest.dependencies ?? {} }
  } catch {
    return { bundles: [], dependencies: {} }
  }
}

/**
 * Split the Windows plugins into enabled, disabled (installed but not enabled)
 * and skipped.
 * @returns `{ enabled, disabled, skipped }` — each entry `{ name, spec }`.
 */
export function planPlugins(config) {
  const { dependencies, bundles } = readWindowsProfile()
  const enabledSet = new Set(bundles)
  const enabled = []
  const disabled = []
  const skipped = []
  for (const [name, version] of Object.entries(dependencies)) {
    if (SKIP.some((pattern) => pattern.test(name))) continue
    const isLink = version.startsWith('link:')
    const isFile = version.startsWith('file:')
    if (isFile) {
      // A Windows temp archive: useless on the WSL side.
      skipped.push({ name, reason: 'file: tarball (not mirrored)' })
      continue
    }
    const target = isLink ? { name, spec: 'link:' + toWslPath(version.slice(5)) } : { name, spec: name + '@' + version.replace(/^[\^~]/, '') }
    if (enabledSet.has(name)) {
      if (isLink && !config.syncLinked) skipped.push({ name, reason: 'link (set syncLinked to include)' })
      else enabled.push(target)
    } else if (isLink && !config.syncLinked) {
      skipped.push({ name, reason: 'disabled link (set syncLinked to include)' })
    } else {
      disabled.push(target)
    }
  }
  return { enabled, disabled, skipped }
}

/** Make sure the enabled plugins sit in the WSL bundle list. */
export function ensureBundles(names) {
  const script = [
    "python3 - <<'PY'",
    'import json, os',
    "p = os.path.expanduser('~/.dsh/profiles/web/package.json')",
    'd = json.load(open(p))',
    "b = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])",
    'names = ' + JSON.stringify(names),
    'changed = False',
    'for n in names:',
    '    if n not in b:',
    '        b.append(n); changed = True',
    "json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)",
    "print('BUNDLES_' + ('UPDATED' if changed else 'OK'))",
    'PY',
  ].join('\n')
  return wsl(script, 30000).out.includes('BUNDLES_UPDATED')
}

/** Keep disabled plugins OUT of the WSL bundle list. */
export function deactivateBundles(names) {
  const script = [
    "python3 - <<'PY'",
    'import json, os',
    "p = os.path.expanduser('~/.dsh/profiles/web/package.json')",
    'd = json.load(open(p))',
    "b = d.get('dsh', {}).get('profile', {}).get('bundles', [])",
    'names = ' + JSON.stringify(names),
    'changed = False',
    'for n in names:',
    '    if n in b:',
    '        b.remove(n); changed = True',
    "json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)",
    "print('BUNDLES_' + ('UPDATED' if changed else 'OK'))",
    'PY',
  ].join('\n')
  return wsl(script, 30000).out.includes('BUNDLES_UPDATED')
}

/**
 * Full mirror of the Windows plugin state (enabled + disabled) into WSL.
 * @returns `{ added, removed, failed, unchanged, bundlesUpdated, configsMerged }`.
 */
export function syncPlugins(config) {
  const { enabled, disabled, skipped } = planPlugins(config)
  const enabledNames = enabled.map((p) => p.name)
  const disabledNames = disabled.map((p) => p.name)
  const wslManifest = readWslManifest()
  const toInstall = [...enabled, ...disabled].filter((p) => wslManifest.dependencies[p.name] === undefined)

  const lines = [
    'export PATH="$PATH:$HOME/.local/node/bin"',
    'if ! command -v pnpm >/dev/null 2>&1; then corepack enable pnpm >/dev/null 2>&1 || true; fi',
    'NODE="$HOME/.local/node/bin/node"',
    'DSH_JS="$HOME/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"',
    'if [ ! -f "$DSH_JS" ]; then echo WSL_DESKTOP_NO_DSH; exit 4; fi',
    'add() {',
    '  if "$NODE" "$DSH_JS" plugin --profile web add "$1" >/tmp/wsl-desktop-add.log 2>&1; then echo "ADD_OK $1"; else echo "ADD_FAIL $1"; tail -2 /tmp/wsl-desktop-add.log; fi',
    '}',
  ]
  for (const plan of toInstall) lines.push("add '" + plan.spec.replaceAll("'", "'\\''") + "'")

  const result = wslLoginOut(lines.join('\n'), 900000)
  const added = []
  const failed = []
  for (const match of result.out.matchAll(/ADD_OK (\S+)/g)) added.push(match[1])
  for (const match of result.out.matchAll(/ADD_FAIL (\S+)/g)) failed.push(match[1])
  if (result.out.includes('WSL_DESKTOP_NO_DSH')) failed.push('WSL DSH runtime missing')

  const wslAfter = readWslManifest()
  const present = (name) => wslAfter.dependencies[name] !== undefined
  // Only a plugin that actually installed may be enabled; a failed install must
  // not leave an unresolvable bundle reference behind (the next boot reports it).
  const bundlesUpdated = ensureBundles(enabledNames.filter(present))
  const bundlesDeactivated = deactivateBundles(enabledNames.filter((name) => !present(name)))
  const configsMerged = mergePluginConfigs([...enabledNames, ...disabledNames])
  const changed = toInstall.length > 0 || bundlesUpdated || bundlesDeactivated || configsMerged
  return { added, removed: [], failed, skipped, unchanged: !changed, bundlesUpdated, bundlesDeactivated, configsMerged }
}

/** Remove plugins again (used to roll back a profile that no longer boots). */
export function removePlugins(names) {
  if (names.length === 0) return
  const lines = [
    'export PATH="$PATH:$HOME/.local/node/bin"',
    'NODE="$HOME/.local/node/bin/node"',
    'DSH_JS="$HOME/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"',
  ]
  for (const name of names) lines.push('"$NODE" "$DSH_JS" plugin --profile web remove \'' + name.replaceAll("'", "'\\''") + '\' >/tmp/wsl-desktop-remove.log 2>&1 || true')
  wsl(lines.join('\n'), 600000)
}

/** Restart the WSL Host and wait for it to report its web URL. */
export function restartAndVerify() {
  const script = [
    'cd ~',
    // Kill whoever actually listens on the port: a stale pid file used to leave
    // the listener alive and the new Host died with EADDRINUSE.
    'listener=$(ss -ltnp 2>/dev/null | grep ":3080 " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)',
    'if [ -n "$listener" ]; then kill "$listener" 2>/dev/null || true; sleep 1; fi',
    'if [ -f "$HOME/dsh-wsl-host.pid" ] && kill -0 "$(cat "$HOME/dsh-wsl-host.pid")" 2>/dev/null; then kill "$(cat "$HOME/dsh-wsl-host.pid")"; sleep 1; fi',
    '[ -f "$HOME/dsh-wsl-host.log" ] && mv -f "$HOME/dsh-wsl-host.log" "$HOME/dsh-wsl-host.log.1"',
    'NODE="$HOME/.local/node/bin/node"',
    'DSH_JS="$HOME/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"',
    'setsid nohup "$NODE" "$DSH_JS" --profile web --no-open --port 3080 > "$HOME/dsh-wsl-host.log" 2>&1 < /dev/null &',
    'host_pid=""',
    'for i in $(seq 1 40); do',
    '  host_pid=$(ss -ltnp 2>/dev/null | grep ":3080 " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)',
    '  if [ -n "$host_pid" ]; then echo "$host_pid" > "$HOME/dsh-wsl-host.pid"; break; fi',
    '  sleep 0.5',
    'done',
    'for i in $(seq 1 90); do grep -q "^dsh web:" "$HOME/dsh-wsl-host.log" && break; sleep 1; done',
    'if grep -q "^dsh web:" "$HOME/dsh-wsl-host.log"; then echo HOST_OK; else echo HOST_FAIL; tail -8 "$HOME/dsh-wsl-host.log"; fi',
    'exit 0',
  ].join('\n')
  return wslHost(script, 180000).out.includes('HOST_OK')
}

export function stopWslHost() {
  return wsl([
    'if [ -f "$HOME/dsh-wsl-host.pid" ] && kill -0 "$(cat "$HOME/dsh-wsl-host.pid")" 2>/dev/null; then',
    '  kill "$(cat "$HOME/dsh-wsl-host.pid")"; sleep 1; rm -f "$HOME/dsh-wsl-host.pid"; echo STOPPED',
    'else',
    '  echo NOT_RUNNING',
    'fi',
  ].join('\n'), 30000)
}

/**
 * Enable DSH's official terminal bundle in the WSL web profile: the WSL window
 * then gets interactive shell tabs in the sidebar (real PTY, running in WSL).
 * @returns `{ added, present, missing }`.
 */
export function enableWslTerminal() {
  const script = [
    "python3 - <<'PY'",
    'import json, os',
    "p = os.path.expanduser('~/.dsh/profiles/web/package.json')",
    "install = os.path.expanduser('~/.local/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-terminal-bundle')",
    "bundle = '@deepseek-ai/dsh-experimental-terminal-bundle'",
    'if not os.path.isdir(install):',
    "    print('TERMINAL_BUNDLE_MISSING')",
    '    raise SystemExit(0)',
    'with open(p) as handle:',
    '    d = json.load(handle)',
    "b = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])",
    'if bundle in b:',
    "    print('TERMINAL_BUNDLE_PRESENT')",
    '    raise SystemExit(0)',
    'b.append(bundle)',
    'with open(p, "w") as handle:',
    '    json.dump(d, handle, indent=2, ensure_ascii=False)',
    '    handle.write("\\n")',
    "print('TERMINAL_BUNDLE_ADDED')",
    'PY',
    'exit 0',
  ].join('\n')
  const out = wsl(script, 30000).out
  return {
    added: out.includes('TERMINAL_BUNDLE_ADDED'),
    present: out.includes('TERMINAL_BUNDLE_PRESENT'),
    missing: out.includes('TERMINAL_BUNDLE_MISSING'),
  }
}

/**
 * Read the running WSL Host's pid/port/start and whether any config source is
 * newer than it (which means the next window open restarts it).
 * @returns `{ alive, pid, port, startedAt, newest, stale }`.
 */
export function hostState() {
  const script = [
    'PID="$HOME/dsh-wsl-host.pid"',
    'p=""; [ -f "$PID" ] && p=$(cat "$PID" 2>/dev/null || true)',
    'alive=0',
    'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null | grep -q "bin.js"; then alive=1; fi',
    'port=""',
    'if [ "$alive" = 1 ]; then port=$(ss -ltnp 2>/dev/null | grep "pid=$p," | sed -E "s/.*:([0-9]+) .*/\\1/" | head -1); fi',
    'newest=0',
    'for f in "$HOME/.dsh/.env" "$HOME/.dsh/.credentials.yaml" "$HOME/.dsh/cordis.patch.yml" "$HOME/.dsh/settings.yaml" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc"; do',
    '  [ -f "$f" ] || continue',
    '  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
    '  [ "$m" -gt "$newest" ] && newest=$m',
    'done',
    'for f in "$HOME/.dsh/profiles/web"/*; do',
    '  [ -f "$f" ] || continue',
    '  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
    '  [ "$m" -gt "$newest" ] && newest=$m',
    'done',
    'started=0',
    'if [ "$alive" = 1 ]; then e=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d " "); case "$e" in ""|*[!0-9]*) e=0 ;; esac; started=$(( $(date +%s) - e )); fi',
    'stamp=0',
    'if [ -f "$HOME/dsh-wsl-host.cfgstamp" ]; then stamp=$(cat "$HOME/dsh-wsl-host.cfgstamp" 2>/dev/null || echo 0); fi',
    'case "$stamp" in ""|*[!0-9]*) stamp=0 ;; esac',
    'echo "STATE alive=$alive pid=$p port=$port newest=$newest started=$started stamp=$stamp"',
    'exit 0',
  ].join('\n')
  const out = wsl(script, 30000).out
  const match = /STATE alive=(\d) pid=(\S*) port=(\S*) newest=(\d+) started=(\d+) stamp=(\d+)/.exec(out)
  if (match === null) return { alive: false, pid: '', port: '', startedAt: 0, newest: 0, stamp: 0, stale: false }
  const startedAt = Number(match[5])
  const newest = Number(match[4])
  const stamp = Number(match[6])
  const baseline = stamp > 0 ? stamp : startedAt
  return {
    alive: match[1] === '1',
    pid: match[2],
    port: match[3],
    startedAt,
    newest,
    stamp,
    stale: baseline > 0 && newest > baseline,
  }
}

export function isCopyRunning(config) {
  const exe = path.join(config.installDir, 'DeepSeek Harness.exe')
  const command = `(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replaceAll("'", "''")}' }).Count`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  })
  const count = Number(String(result.stdout ?? '').trim())
  return Number.isFinite(count) && count > 0
}