/**
 * wsl-remote.cjs — bring up (or reuse) the DSH Host inside WSL and return its
 * tokenized launch URL. Loaded from the patched Desktop shell via
 * `createRequire`; runs synchronously on the Electron main thread.
 *
 * Environment: DSH_WSL_PORT (default 3080), DSH_WSL_DISTRO (default: WSL default
 * distro), DSH_WSL_VERSION (default 0.2.2-rc.5), DSH_WSL_AUTOINSTALL (default 1).
 */
const { execFileSync } = require('node:child_process')

const NODE_VERSION = 'v24.21.0'
const ALLOW_SCRIPTS = '@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs'
const PORT = Number(process.env.DSH_WSL_PORT || 3080)
const DISTRO = (process.env.DSH_WSL_DISTRO || '').trim()
const VERSION = process.env.DSH_WSL_VERSION || '0.2.2-rc.5'
const AUTO_INSTALL = process.env.DSH_WSL_AUTOINSTALL !== '0'

// Run under an interactive login shell so ~/.bashrc and ~/.profile apply, like
// a normal WSL terminal (a plain `bash -s` is neither login nor interactive
// and skips them). `-s` still reads the script from stdin; the host scripts
// end with `exit 0`, so the shell's EOF status never masks their result.
const BASH = ['--', 'bash', '-lis']

const PREFACE = [
  'set -u',
  'if [ -x $HOME/.local/node/bin/node ]; then NODE=$HOME/.local/node/bin/node; elif command -v node >/dev/null 2>&1; then NODE=$(command -v node); fi',
  'DSH_JS=$HOME/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
].join('\n')

function wsl(script, timeoutMs) {
  const args = DISTRO === '' ? BASH : ['-d', DISTRO, ...BASH]
  const output = execFileSync('wsl.exe', args, {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return String(output ?? '')
}

function ensureRuntime(preamble) {
  const script = `${preamble}
need=0
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then need=1; fi
if [ "$need" = 1 ]; then
  if [ "${AUTO_INSTALL ? '1' : '0'}" != "1" ]; then echo WSL_DESKTOP_RUNTIME_MISSING; exit 3; fi
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) a=x64 ;;
    aarch64|arm64) a=arm64 ;;
    *) echo WSL_DESKTOP_ARCH_UNSUPPORTED; exit 3 ;;
  esac
  mkdir -p $HOME/.local/node /tmp/dsh-wsl-desktop
  curl -fL --retry 3 https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-$a.tar.xz -o /tmp/dsh-wsl-desktop/node.tar.xz || exit 3
  tar -xJf /tmp/dsh-wsl-desktop/node.tar.xz -C $HOME/.local/node --strip-components=1 || exit 3
  NODE=$HOME/.local/node/bin/node
  export PATH=$(dirname "$NODE"):$PATH
fi
if [ ! -f "$DSH_JS" ]; then
  if [ "${AUTO_INSTALL ? '1' : '0'}" != "1" ]; then echo WSL_DESKTOP_DSH_MISSING; exit 3; fi
  export PATH=$(dirname "$NODE"):$PATH
  npm i -g --prefix $HOME/.local/dsh @deepseek-ai/dsh@${VERSION} --no-audit --no-fund --allow-scripts=${ALLOW_SCRIPTS} || exit 3
fi
echo WSL_DESKTOP_RUNTIME_READY
exit 0
`
  return wsl(script, 600000)
}

function startOrReuse(preamble) {
  const script = `${preamble}
cd ~
PID=$HOME/dsh-wsl-host.pid
LOG=$HOME/dsh-wsl-host.log
STAMP=$HOME/dsh-wsl-host.cfgstamp
port=${PORT}
host_pid=""
reuse=0

host_is_dsh() {
  [ -n "\${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  tr '\\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q 'bin.js'
}

config_newest() {
  n=0
  for f in "$HOME/.dsh/.env" "$HOME/.dsh/.credentials.yaml" "$HOME/.dsh/cordis.patch.yml" "$HOME/.dsh/settings.yaml" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc"; do
    [ -f "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$n" ] && n=$m
  done
  # Every top-level file of the web profile (cordis.yml, cordis.patch.yml,
  # package.json, pnpm-workspace.yaml, …) is configuration too; only the
  # installed tree (node_modules, .plugin-manager, …) is skipped.
  for f in "$HOME/.dsh/profiles/web"/*; do
    [ -f "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$n" ] && n=$m
  done
  echo "$n"
}

# 1) the pid file, when it still names one of our Host processes
if [ -f "$PID" ]; then
  candidate=$(cat "$PID" 2>/dev/null || true)
  if host_is_dsh "$candidate"; then host_pid=$candidate; reuse=1; fi
fi

# 2) recover from the log when the pid file is missing or stale (setsid may
#    fork, so the recorded pid used to be the launcher's, not the Host's)
if [ "$reuse" = 0 ] && [ -f "$LOG" ]; then
  line=$(grep -m1 '^dsh web: ' "$LOG" 2>/dev/null || true)
  if [ -n "$line" ]; then
    found_port=$(printf '%s' "$line" | sed -E 's#^dsh web: http://127\\.0\\.0\\.1:([0-9]+)/.*#\\1#')
    if [ -n "$found_port" ] && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$found_port$"; then
      found_pid=$(ss -ltnp 2>/dev/null | grep ":$found_port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
      if host_is_dsh "$found_pid"; then
        host_pid=$found_pid
        port=$found_port
        echo "$host_pid" > "$PID"
        reuse=1
      fi
    fi
  fi
fi

# 3) restart when the config changed since the last settled stamp (the stamp is
#    written after the Host's boot-time rewrites settle, so a boot-time route
#    rewrite right after a start does not restart it on the next launch)
if [ "$reuse" = 1 ]; then
  stamp=0
  if [ -f "$STAMP" ]; then stamp=$(cat "$STAMP" 2>/dev/null || echo 0); fi
  case "$stamp" in ''|*[!0-9]*) stamp=0 ;; esac
  if [ "$stamp" -eq 0 ]; then
    etimes=$(ps -o etimes= -p "$host_pid" 2>/dev/null | tr -d ' ')
    case "$etimes" in ''|*[!0-9]*) etimes=999999999 ;; esac
    stamp=$(( $(date +%s) - etimes ))
  fi
  if [ "$(config_newest)" -gt "$stamp" ]; then
    kill "$host_pid" 2>/dev/null || true
    sleep 1
    reuse=0
  fi
fi

# 4) start a Host and record the real listening pid
if [ "$reuse" = 0 ]; then
  i=0
  while [ "$i" -lt 20 ]; do
    if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$port$"; then break; fi
    port=$((port+1)); i=$((i+1))
  done
  [ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
  setsid nohup "$NODE" "$DSH_JS" --profile web --no-open --port "$port" > "$LOG" 2>&1 < /dev/null &
  host_pid=""
  for i in $(seq 1 40); do
    host_pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    if [ -n "$host_pid" ]; then echo "$host_pid" > "$PID"; break; fi
    sleep 0.5
  done
fi

for i in $(seq 1 60); do
  grep -q '^dsh web:' "$LOG" 2>/dev/null && break
  sleep 1
done

# Wait until boot-time config rewrites settle, then pinch the stamp.
n=$(config_newest)
for i in $(seq 1 8); do
  sleep 1
  n2=$(config_newest)
  [ "$n" = "$n2" ] && break
  n=$n2
done
echo "$n" > "$STAMP"

grep -m1 '^dsh web:' "$LOG" 2>/dev/null || true
exit 0
`
  return wsl(script, 120000)
}

/** @returns the WSL Host's tokenized URL, or null when unavailable. */
function remoteUrl() {
  try {
    ensureRuntime(PREFACE)
    const out = startOrReuse(PREFACE)
    const match = /dsh web:\s*(\S+)/.exec(out)
    return match === null ? null : match[1]
  } catch (error) {
    throw new Error('wsl-desktop: failed to bring up the WSL Host: ' + (error instanceof Error ? error.message : String(error)))
  }
}

module.exports = { remoteUrl }