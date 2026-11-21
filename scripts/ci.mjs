/**
 * CI checks for @karoy/dsh-wsl-desktop (plain ESM, no build step):
 * - every source file parses (`node --check`);
 * - the package manifest points at existing files and exports;
 * - the bundle patch and the client module id use the manifest's package name
 *   (a rename that misses one of them must fail here, not at runtime).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const failures = []

function fail(message) {
  failures.push(message)
  console.error('FAIL ' + message)
}

function ok(message) {
  console.log('ok   ' + message)
}

function walk(dir, visited = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, visited)
    else visited.push(full)
  }
  return visited
}

const files = walk(root)
const sources = files.filter((file) => /\.(m?js|cjs)$/.test(file))
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' })
  if (result.status !== 0) fail('syntax: ' + path.relative(root, source) + '\n' + String(result.stderr))
}
if (failures.length === 0) ok(sources.length + ' source files parse')

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const field of ['name', 'version', 'type', 'exports', 'files', 'dsh']) {
  if (manifest[field] === undefined) fail('package.json is missing "' + field + '"')
}
ok('manifest fields present')

for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  if (key.includes('*')) continue
  const target = typeof value === 'string' ? value : value.default
  if (typeof target !== 'string' || !fs.existsSync(path.join(root, target))) fail('exports.' + key + ' → ' + String(target) + ' does not exist')
}
ok('exports resolve')

const fileList = Array.isArray(manifest.files) ? manifest.files : []
for (const entry of fileList) {
  if (entry.startsWith('!')) continue
  if (!fs.existsSync(path.join(root, entry))) fail('files entry "' + entry + '" does not exist')
}
ok('files entries exist')

const patch = manifest.dsh?.bundle?.patch
if (typeof patch !== 'string' || !fs.existsSync(path.join(root, patch))) {
  fail('dsh.bundle.patch is missing or does not exist')
} else {
  const text = fs.readFileSync(path.join(root, patch), 'utf8')
  if (!text.includes("'" + manifest.name + "'") && !text.includes('"' + manifest.name + '"')) {
    fail('bundle patch does not reference the package name "' + manifest.name + '"')
  } else {
    ok('bundle patch references ' + manifest.name)
  }
}

const clientPath = path.join(root, 'client.js')
if (fs.existsSync(clientPath)) {
  const client = fs.readFileSync(clientPath, 'utf8')
  if (!client.includes("'" + manifest.name + "'") && !client.includes('"' + manifest.name + '"')) {
    fail('client.js module id does not match "' + manifest.name + '"')
  } else {
    ok('client module id matches ' + manifest.name)
  }
}

if (failures.length > 0) {
  console.error('\n' + failures.length + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')