import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require$ = createRequire(import.meta.url)
const yaml = require$('yaml')

/** Windows temp file path spoken in WSL terms (`C:\...` → `/mnt/c/...`). */
function wslTempPath() {
  const tmp = path.join(os.tmpdir(), 'dsh-wsl-patch-merge.yml')
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(tmp)
  return match === null ? tmp : '/mnt/' + match[1].toLowerCase() + '/' + match[2].replaceAll('\\', '/')
}

function readDesktopProfile() {
  const manifest = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  return { deps: data.dependencies ?? {}, bundles: data.dsh?.profile?.bundles ?? [] }
}

function readWslPatch() {
  const result = spawnSync('wsl.exe', ['--', 'bash', '-s'], {
    input: 'cat "$HOME/.dsh/profiles/web/cordis.patch.yml"',
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error('wsl-desktop: cannot read the WSL patch: ' + String(result.stderr))
  return yaml.parse(String(result.stdout))
}

function writeWslPatch(documents) {
  const text = yaml.stringify(documents)
  const winTmp = path.join(os.tmpdir(), 'dsh-wsl-patch-merge.yml')
  fs.writeFileSync(winTmp, text, 'utf8')
  const result = spawnSync('wsl.exe', ['--', 'bash', '-s'], {
    input: 'cat "' + wslTempPath() + '" > "$HOME/.dsh/profiles/web/cordis.patch.yml"',
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  try { fs.unlinkSync(winTmp) } catch { /* ignore */ }
  if (result.status !== 0) throw new Error('wsl-desktop: cannot write the WSL patch: ' + String(result.stderr))
}

/**
 * Copy every non-link plugin's profile rows (id/name/enabled/config) from the
 * Windows desktop patch into the WSL web patch, honoring the enable state:
 * plugins not enabled on Windows get `enabled: false` rows and stay out of the
 * WSL bundle list. Shipped `@deepseek-ai/*` and local `link:` packages are not
 * touched.
 * @returns whether the WSL patch changed.
 */
export function mergePluginConfigs(onlyNames) {
  const { deps, bundles } = readDesktopProfile()
  const enabledSet = new Set(bundles.filter((name) => !name.startsWith('@deepseek-ai/')))
  const names = (onlyNames ?? Object.keys(deps))
    .filter((name) => deps[name] !== undefined && !deps[name].toString().startsWith('link:'))
    .filter((name) => !name.startsWith('@deepseek-ai/') && !name.startsWith('@local/') && !name.includes('dsh-wsl-desktop'))

  if (names.length === 0) return false

  const desktopRows = yaml.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')) ?? []
  const wslRows = readWslPatch() ?? []
  const wslById = new Map(wslRows.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, row]))
  let changed = false

  for (const name of names) {
    const fromDesktop = desktopRows.filter((row) => row && row.name === name)
    const enabled = enabledSet.has(name)
    if (fromDesktop.length === 0) continue
    for (const row of fromDesktop) {
      const copy = { id: row.id, name: row.name }
      if (row.enabled !== undefined || !enabled) copy.enabled = row.enabled === true ? true : enabled
      if (row.config !== undefined) copy.config = row.config
      const existing = wslById.get(row.id)
      if (existing === undefined) {
        wslRows.push(copy)
        wslById.set(row.id, copy)
        changed = true
      } else {
        const prev = JSON.stringify(existing)
        Object.keys(existing).forEach((key) => delete existing[key])
        Object.assign(existing, copy)
        if (JSON.stringify(existing) !== prev) changed = true
      }
    }
  }

  if (changed) writeWslPatch(wslRows)
  return changed
}