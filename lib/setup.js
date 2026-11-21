/**
 * Install a patched DSH Desktop copy that proxies its Host connection to a DSH
 * Host running inside WSL. Nothing in the original installation is modified:
 * the copy lives in `installDir` and keeps its own Electron userData and DSH_HOME.
 *
 * `mode: 'proxy'` keeps the dsh-app://app page (desktop chrome, native dialogs)
 * and swaps only the Host URL/cookie; it requires the WSL Host to serve the
 * same profile/plugin graph as the copy's local child Host.
 * `mode: 'direct'` loads the WSL Host page in the main window (no desktop chrome,
 * no profile parity requirement).
 *
 * @module @karoy/dsh-wsl-desktop/setup
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { writeStamp } from './state.js'

const require$ = createRequire(import.meta.url)

const MARKER = 'wsl-desktop patch'
const HELPER_MARKER = 'wslDesktopRequire'

export const DEFAULT_CONFIG = {
  installDir: '',
  userDataDirName: 'DeepSeek Harness WSL',
  port: 3080,
  distro: '',
  autoInstall: true,
  mode: 'proxy',
  autoRun: true,
  autoSetup: true,
  autoLaunch: false,
  syncWslPlugins: true,
}

/** Default copy location: `%LOCALAPPDATA%\\DeepSeek Harness WSL Desktop` (any drive, per user). */
export function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'DeepSeek Harness WSL Desktop')
}

/** Merge plugin config with defaults and resolve the copy directory. */
export function resolveConfig(pluginConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...pluginConfig }
  if (config.installDir === '' || config.installDir === undefined) config.installDir = defaultInstallDir()
  return config
}

function log(line) {
  console.log('[wsl-desktop] ' + line)
}

function run(command, args, options) {
  log(command + ' ' + args.join(' '))
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
  if (result.error !== undefined) throw result.error
  return result.status ?? 0
}

/** Locate the installed Desktop application (the directory holding resources/app.asar). */
export function resolveSourceDir(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  const exeDir = path.dirname(process.execPath)
  candidates.push(exeDir)
  if (process.env.DSH_DESKTOP_DIR) candidates.push(process.env.DSH_DESKTOP_DIR)
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'DeepSeek Harness'))
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'resources', 'app.asar'))) return candidate
  }
  throw new Error('wsl-desktop: cannot find the Desktop install (resources/app.asar)')
}

function copyInstall(sourceDir, installDir) {
  if (fs.existsSync(installDir)) {
    log('removing previous copy ' + installDir)
    fs.rmSync(installDir, { recursive: true, force: true })
  }
  fs.mkdirSync(installDir, { recursive: true })
  // Skip what the copy does not need: app.asar (extracted straight from the
  // installed app) and its unpacked payload (extractAll pulls those files from
  // the source's app.asar.unpacked). Together they are ~450 MB of the ~1 GB
  // install, and skipping the archive also avoids racing its rename (EBUSY).
  const status = run('robocopy', [
    sourceDir, installDir, '/E', '/NFL', '/NDL', '/NJH', '/NP',
    '/XF', 'app.asar', '/XD', 'app.asar.unpacked',
  ])
  if (status > 7) throw new Error('wsl-desktop: robocopy failed with ' + String(status))
}

function extractAsar(sourceDir, resourcesDir) {
  const sourceAsar = path.join(sourceDir, 'resources', 'app.asar')
  if (!fs.existsSync(sourceAsar)) throw new Error('wsl-desktop: source resources/app.asar is missing')
  const app = path.join(resourcesDir, 'app')
  const mainPath = path.join(app, 'lib', 'main.js')
  if (!fs.existsSync(mainPath)) {
    fs.rmSync(app, { recursive: true, force: true })
    require$('@electron/asar').extractAll(sourceAsar, app)
  }
  if (!fs.existsSync(mainPath)) throw new Error('wsl-desktop: asar extraction produced no app/lib/main.js')
}

export function patchMain(mainPath, config) {
  let text = fs.readFileSync(mainPath, 'utf8')

  if (!text.includes(HELPER_MARKER)) {
    const anchor = 'import { REMOTE_STREAM_MUX_PATH, parseRemoteStreamServerMessage } from "@deepseek-ai/dsh-api-gateway/stream-protocol";\n'
    if (!text.includes(anchor)) throw new Error('wsl-desktop: import anchor not found in main.js')
    const helper = anchor + `/* ---- ${MARKER} ---- */
const wslDesktopRequire = createRequire(import.meta.url);
function desktopWslUrl() {
  if (process.env.DSH_WSL_DESKTOP !== "1") return null;
  try { return wslDesktopRequire("./wsl-remote.cjs").remoteUrl(); }
  catch (error) { console.error("wsl-desktop: WSL Host unavailable, using local Host", error); return null; }
}
async function desktopWslReady(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fetch(url, { redirect: "manual" }); return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
if (process.env.DSH_WSL_DESKTOP === "1") {
  try { app.setPath("userData", join(app.getPath("appData"), ${JSON.stringify(config.userDataDirName)})); }
  catch (error) { console.error("wsl-desktop: userData override failed", error); }
}
/* ---- end ${MARKER} ---- */
`
    text = text.replace(anchor, helper)
  }

  const readyLine = 'const ready = await host.start();'
  const readyCount = text.split(readyLine).length - 1
  if (readyCount !== 1) throw new Error('wsl-desktop: expected one host.start() site, found ' + String(readyCount))

  if (config.mode === 'direct') {
    if (!text.includes('DSH_WSL_DIRECT')) {
      const target = 'navigateMain(applicationUrl)'
      const sites = text.split(target).length - 1
      if (sites !== 4) throw new Error('wsl-desktop: expected 4 navigation sites, found ' + String(sites))
      text = text.split(target).join('navigateMain(await desktopWslUrl() ?? applicationUrl)')
      text = text.replace(
        'openInitialWindow() : navigateMain(await desktopWslUrl() ?? applicationUrl)',
        'openInitialWindow() : navigateMain(desktopWslUrl() ?? applicationUrl)',
      )
      text = text.replace(
        'webPreferences: {\n\t\t\tpreload,\n\t\t\tnodeIntegration: false,',
        'webPreferences: {\n\t\t\tpreload: process.env.DSH_WSL_DESKTOP === "1" ? void 0 : preload,\n\t\t\tnodeIntegration: false,',
      )
      text = text.replace(
        '...process.platform === "win32" && primary ? {\n\t\t\tbackgroundColor: chromeFallbackFill(),\n\t\t\ttitleBarStyle: "hidden",',
        '...process.platform === "win32" && primary ? (process.env.DSH_WSL_DESKTOP === "1" ? {\n\t\t\tbackgroundColor: chromeFallbackFill(),\n\t\t\t/* DSH_WSL_DIRECT */\n\t\t} : {\n\t\t\tbackgroundColor: chromeFallbackFill(),\n\t\t\ttitleBarStyle: "hidden",',
      )
      text = text.replace(
        '\t\t\t\tcolor: chromeFallbackFill(),\n\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"\n\t\t\t}\n\t\t} : {},',
        '\t\t\t\tcolor: chromeFallbackFill(),\n\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"\n\t\t\t}\n\t\t}) : {},',
      )
      text = text.replace(
        '\tconst refreshApplicationMenu = () => {\n\t\tMenu.setApplicationMenu(',
        '\tconst refreshApplicationMenu = () => {\n\t\tif (process.env.DSH_WSL_DESKTOP === "1") { Menu.setApplicationMenu(null); tray?.relabel(); return; }\n\t\t/* DSH_WSL_DIRECT */\n\t\tMenu.setApplicationMenu(',
      )
    }
  } else if (!text.includes('/* DSH_WSL_PROXY */')) {
    const injection = readyLine + `
\t\t\t\t/* DSH_WSL_PROXY */
\t\t\t\tif (process.env.DSH_WSL_DESKTOP === "1") {
\t\t\t\t\tconst wslUrl = desktopWslUrl();
\t\t\t\t\tif (wslUrl !== null && await desktopWslReady(wslUrl)) ready.url = wslUrl;
\t\t\t\t}`
    text = text.replace(readyLine, injection)
  }

  if (config.mode !== 'direct' && !text.includes('/* DSH_WSL_INJECTIONS */')) {
    const cookieLine = 'const cookie = await authenticateWebHost(ready.url);'
    const sites = text.split(cookieLine).length - 1
    if (sites !== 1) throw new Error('wsl-desktop: expected one authenticateWebHost site, found ' + String(sites))
    text = text.replace(cookieLine, cookieLine + `
\t\t\t\t/* DSH_WSL_INJECTIONS */
\t\t\t\tif (process.env.DSH_WSL_DESKTOP === "1") {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst pageHtml = await (await fetch(new URL("/", ready.url), { headers: { cookie } })).text();
\t\t\t\t\t\tconst rows = [];
\t\t\t\t\t\tconst bodyAt = pageHtml.search(/<body(?:\\s[^>]*)?>/i);
\t\t\t\t\t\tconst tagRe = /<(script|style|link)([^>]*)>([\\s\\S]*?)<\\/\\1>/gi;
\t\t\t\t\t\tlet tagMatch;
\t\t\t\t\t\twhile ((tagMatch = tagRe.exec(pageHtml)) !== null) {
\t\t\t\t\t\t\tconst tag = tagMatch[1].toLowerCase();
\t\t\t\t\t\t\tconst attrs = tagMatch[2];
\t\t\t\t\t\t\tconst inner = tagMatch[3];
\t\t\t\t\t\t\tconst placement = bodyAt !== -1 && tagMatch.index > bodyAt ? "body" : "head";
\t\t\t\t\t\t\tif (tag === "script") {
\t\t\t\t\t\t\t\tif (/\\btype\\s*=\\s*["']module["']/i.test(attrs)) continue;
\t\t\t\t\t\t\t\tif (inner.indexOf("__DSH_BOOT_READY__") !== -1) continue;
\t\t\t\t\t\t\t\tconst srcMatch = /\\bsrc\\s*=\\s*["']([^"']+)["']/i.exec(attrs);
\t\t\t\t\t\t\t\tif (srcMatch !== null) rows.push({ kind: "script-src", placement, src: srcMatch[1].replace(/&amp;/g, "&") });
\t\t\t\t\t\t\t\telse if (inner.trim() !== "") rows.push({ kind: "script", placement, text: inner });
\t\t\t\t\t\t\t} else if (tag === "style") {
\t\t\t\t\t\t\t\trows.push({ kind: "style", text: inner });
\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\tconst rel = /\\brel\\s*=\\s*["']([^"']+)["']/i.exec(attrs);
\t\t\t\t\t\t\t\tif (rel === null) continue;
\t\t\t\t\t\t\t\tif (rel[1].toLowerCase() === "stylesheet") rows.push({ kind: "html", placement, html: tagMatch[0] });
\t\t\t\t\t\t\t\telse if (rel[1].toLowerCase() === "preload") {
\t\t\t\t\t\t\t\t\tconst href = /\\bhref\\s*=\\s*["']([^"']+)["']/i.exec(attrs);
\t\t\t\t\t\t\t\t\tif (href !== null) rows.push({ kind: "script-preload", src: href[1].replace(/&amp;/g, "&") });
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\tif (rows.length > 0) ready.injections = rows;
\t\t\t\t\t} catch (error) { console.error("wsl-desktop: injection bridge failed", error); }
\t\t\t\t/* DSH_WSL_RUNNING */
\t\t\t\tif (process.env.DSH_WSL_DESKTOP === "1" && process.env.DSH_WSL_MODE !== "direct") {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst marker = join(app.getAppPath(), "..", "..", ".dsh-wsl-running.json");
\t\t\t\t\t\twriteFileSync(marker, JSON.stringify({ mode: "proxy", pid: process.pid, at: new Date().toISOString() }));
\t\t\t\t\t} catch (error) { console.error("wsl-desktop: running marker failed", error); }
\t\t\t\t}
\t\t\t\t}`)
  }

  fs.writeFileSync(mainPath, text)
}

function installHelper(resourcesDir) {
  const source = new URL('./wsl-remote.cjs', import.meta.url)
  const target = path.join(resourcesDir, 'app', 'lib', 'wsl-remote.cjs')
  fs.copyFileSync(source, target)
}

function writeLaunchers(installDir, config) {
  const launcher = `@echo off
rem Launch the WSL-hosted DSH Desktop proxy (${config.mode}); the original install is untouched.
set ELECTRON_RUN_AS_NODE=
set DSH_WSL_DESKTOP=1
set DSH_WSL_MODE=${config.mode}
set DSH_WSL_PORT=${String(config.port)}
set DSH_WSL_DISTRO=${config.distro ?? ''}
set DSH_WSL_AUTOINSTALL=${config.autoInstall ? '1' : '0'}
set DSH_HOME=%~dp0dsh-home
start "" "%~dp0DeepSeek Harness.exe"
`
  fs.writeFileSync(path.join(installDir, '启动-WSL-Desktop.cmd'), launcher)

  const rollback = `@echo off
rem Remove the WSL Desktop copy and its isolated Electron profile.
rmdir /s /q "%~dp0"
rmdir /s /q "%APPDATA%\\${config.userDataDirName}"
`
  fs.writeFileSync(path.join(installDir, '卸载-WSL-Desktop.cmd'), rollback)
}

/**
 * Install (or reinstall) the patched copy.
 * @returns a short summary for the command result.
 */
export function setup(pluginConfig = {}) {
  const config = resolveConfig(pluginConfig)
  const sourceDir = resolveSourceDir(config.sourceDir)
  const installDir = config.installDir
  log('source: ' + sourceDir + ' -> ' + installDir + ' (mode ' + config.mode + ')')

  copyInstall(sourceDir, installDir)
  const resourcesDir = path.join(installDir, 'resources')
  extractAsar(sourceDir, resourcesDir)
  const mainPath = path.join(resourcesDir, 'app', 'lib', 'main.js')
  patchMain(mainPath, config)
  installHelper(resourcesDir)
  writeLaunchers(installDir, config)
  writeStamp(installDir, config)

  return [
    `已安装：${installDir}（mode=${config.mode}）`,
    '启动：双击 启动-WSL-Desktop.cmd（会复用/启动 WSL 内的 DSH Host）',
    '卸载：双击 卸载-WSL-Desktop.cmd，或删除该目录与 %APPDATA%\\' + config.userDataDirName,
  ].join('\n')
}

/** @returns whether the copy is installed and which mode it carries. */
export function status(pluginConfig = {}) {
  const config = resolveConfig(pluginConfig)
  const mainPath = path.join(config.installDir, 'resources', 'app', 'lib', 'main.js')
  if (!fs.existsSync(mainPath)) return '未安装：' + config.installDir
  const text = fs.readFileSync(mainPath, 'utf8')
  const mode = text.includes('DSH_WSL_PROXY') ? 'proxy' : text.includes('DSH_WSL_DIRECT') ? 'direct' : '未知'
  return `已安装：${config.installDir}（mode=${mode}）`
}

/** Remove the copy and its isolated Electron profile. */
export function remove(pluginConfig = {}) {
  const config = resolveConfig(pluginConfig)
  fs.rmSync(config.installDir, { recursive: true, force: true })
  const userData = path.join(process.env.APPDATA ?? '', config.userDataDirName)
  fs.rmSync(userData, { recursive: true, force: true })
  return '已删除：' + config.installDir + ' 与 ' + userData
}