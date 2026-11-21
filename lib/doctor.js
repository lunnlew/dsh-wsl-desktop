/**
 * Health checks for the WSL desktop bridge. One WSL script reports what it can
 * verify about the Host, the configuration sources and the providers declared in
 * the web profile (key presence, credential-ref shadowing, endpoint answer); the
 * plugin adds the copy's own state. The report is a list of
 * `{ name, state: 'ok' | 'warn' | 'fail', detail }`.
 *
 * Nothing here names a particular gateway: providers come from the profile
 * patch, and a key is only probed against the `baseURL` that patch declares.
 *
 * @module @karoy/dsh-wsl-desktop/doctor
 */
import { spawnSync } from 'node:child_process'
import { needsBuild, readStatus } from './state.js'
import { isCopyRunning } from './sync.js'

function wsl(script, timeoutMs = 60000) {
  const result = spawnSync('wsl.exe', ['--', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  return String(result.stdout ?? '')
}

const SCRIPT = String.raw`
DSH_JS="$HOME/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
PROFILE="$HOME/.dsh/profiles/web"
say() { printf 'CHK %s %s %s\n' "$1" "$2" "$3"; }

# runtime
if [ -x "$HOME/.local/node/bin/node" ] && [ -f "$DSH_JS" ]; then
  say runtime ok "WSL node + DSH runtime present"
else
  say runtime fail "WSL node or DSH runtime missing"
fi

# Host
pid=$(cat "$HOME/dsh-wsl-host.pid" 2>/dev/null || true)
alive=0
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'bin.js'; then alive=1; fi
if [ "$alive" = 1 ]; then
  port=$(ss -ltnp 2>/dev/null | grep "pid=$pid" | sed -E 's/.*:([0-9]+) .*/\1/' | head -1)
  [ -n "$port" ] || port="?"
  since=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
  say host ok "running: pid $pid, port $port, since $since"
else
  say host warn "not running (the next window open starts it)"
fi

# configuration sources vs the stamp the launcher recorded
newest=0
for f in "$HOME/.dsh/.env" "$HOME/.dsh/.credentials.yaml" "$HOME/.dsh/cordis.patch.yml" "$HOME/.dsh/settings.yaml" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc"; do
  [ -f "$f" ] || continue
  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest" ] && newest=$m
done
for f in "$PROFILE"/*; do
  [ -f "$f" ] || continue
  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest" ] && newest=$m
done
stamp=0
[ -f "$HOME/dsh-wsl-host.cfgstamp" ] && stamp=$(cat "$HOME/dsh-wsl-host.cfgstamp" 2>/dev/null || echo 0)
case "$stamp" in ''|*[!0-9]*) stamp=0 ;; esac
if [ "$stamp" -gt 0 ] && [ "$newest" -gt "$stamp" ]; then
  say config warn "configuration changed since the Host started; the next open restarts it"
else
  say config ok "the Host matches the configuration stamp"
fi

# providers declared in the profile: apiKeyEnv + baseURL pairs, in order
pairs=$(awk '/apiKeyEnv:[ ]/{env=$2} /baseURL:[ ]/{if (env != "") { print env " " $2; env = "" }}' "$PROFILE/cordis.patch.yml" 2>/dev/null | sort -u | head -8)
set -a; . "$HOME/.dsh/.env" 2>/dev/null || true; set +a
if [ -z "$pairs" ]; then
  say providers warn "the profile patch declares no apiKeyEnv/baseURL providers"
else
  while read -r env url; do
    [ -n "$env" ] || continue
    value=$(printenv "$env")
    if [ -z "$value" ]; then
      say "key:$env" warn "not set in ~/.dsh/.env"
      continue
    fi
    suffix=$(printf %s "$value" | tail -c 4)
    ref=$(grep -E "^  $env:" "$HOME/.dsh/.credentials.yaml" 2>/dev/null | sed 's/^[^:]*: *//')
    if [ -n "$ref" ] && [ "$ref" != "$value" ]; then
      ref_suffix=$(printf %s "$ref" | tail -c 4)
      say "ref:$env" fail "a stored credential ref ends …$ref_suffix but .env ends …$suffix: the ref wins — remove it from ~/.dsh/.credentials.yaml"
    fi
    [ -n "$url" ] || continue
    target=$(printf %s "$url" | sed 's:/*$::')
    case "$target" in
      */v1) target="$target/models" ;;
      *) target="$target/v1/models" ;;
    esac
    code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $value" "$target" 2>/dev/null || echo 000)
    case "$code" in
      200) say "endpoint:$env" ok "reachable and accepts the key" ;;
      401) say "endpoint:$env" fail "401: the endpoint rejected the key (revoked or mistyped)" ;;
      403) say "endpoint:$env" fail "403: the endpoint refuses this client (network / sharing setting)" ;;
      000) say "endpoint:$env" warn "unreachable" ;;
      *) say "endpoint:$env" warn "HTTP $code" ;;
    esac
  done <<EOF
$pairs
EOF
fi

# package-manager store: a profile linked from another major breaks plugin adds
mods="$PROFILE/node_modules/.modules.yaml"
if [ -f "$mods" ]; then
  store=$(grep -m1 '^storeDir:' "$mods" | sed 's/^storeDir: *//')
  current=$(cd "$PROFILE" && bash -lis -c 'pnpm store path' 2>/dev/null | tail -1)
  if [ -n "$store" ] && [ -n "$current" ]; then
    if [ "$store" = "$current" ]; then
      say store ok "the profile links to the store the launcher resolves"
    else
      say store warn "the profile links to $store but the launcher resolves $current — reinstall the profile's dependencies with the launcher's package manager"
    fi
  fi
fi

# terminal bundle
if grep -q 'dsh-experimental-terminal-bundle' "$PROFILE/package.json" 2>/dev/null; then
  say terminal ok "terminal bundle enabled (shell tabs in the WSL window)"
else
  say terminal warn "terminal bundle not enabled — /wsl-desktop-terminal adds it"
fi
`

/**
 * Run every check and return the report.
 * @param config - the resolved plugin config (for the copy checks).
 * @returns `{ checks: Array<{ name, state, detail }>, ok }`.
 */
export function doctor(config) {
  const checks = []
  for (const line of wsl(SCRIPT).split('\n')) {
    const match = /^CHK (\S+) (\S+) (.*)$/.exec(line.trim())
    if (match !== null) checks.push({ name: match[1], state: match[2], detail: match[3] })
  }

  try {
    checks.push({
      name: 'copy',
      state: isCopyRunning(config) ? 'ok' : 'warn',
      detail: isCopyRunning(config) ? 'the WSL window is running' : 'the WSL window is not running',
    })
    checks.push({
      name: 'build',
      state: needsBuild(config) ? 'warn' : 'ok',
      detail: needsBuild(config) ? 'the copy needs a rebuild (version/mode change or missing)' : 'the copy matches the plugin version',
    })
    const last = readStatus(config.installDir)
    if (last !== null) checks.push({ name: 'auto', state: last.ok === true ? 'ok' : 'fail', detail: 'last helper run: ' + (last.ok === true ? 'ok' : String(last.error)) })
  } catch (error) {
    checks.push({ name: 'copy', state: 'warn', detail: 'copy state unavailable: ' + (error instanceof Error ? error.message : String(error)) })
  }

  return { checks, ok: checks.every((check) => check.state !== 'fail') }
}
