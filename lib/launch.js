/**
 * Start the patched Desktop copy as a detached process. The launcher script
 * (启动-WSL-Desktop.cmd) does the same for manual use; this is the automatic
 * path.
 *
 * @module @karoy/dsh-wsl-desktop/launch
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

export class LaunchError extends Error {}

/** Build the environment the copy expects (no ELECTRON_RUN_AS_NODE, isolated DSH_HOME). */
export function copyEnvironment(config) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.ELECTRON_ENABLE_LOGGING
  Object.assign(env, {
    DSH_WSL_DESKTOP: '1',
    DSH_WSL_MODE: config.mode,
    DSH_WSL_PORT: String(config.port),
    DSH_WSL_DISTRO: config.distro ?? '',
    DSH_WSL_AUTOINSTALL: config.autoInstall ? '1' : '0',
    DSH_HOME: path.join(config.installDir, 'dsh-home'),
  })
  return env
}

/**
 * Launch the copy.
 * @returns the child process id.
 */
export function spawnCopy(config) {
  const exe = path.join(config.installDir, 'DeepSeek Harness.exe')
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    env: copyEnvironment(config),
    windowsHide: false,
  })
  child.unref()
  if (child.pid === undefined) throw new LaunchError('wsl-desktop: could not start the copy')
  return child.pid
}