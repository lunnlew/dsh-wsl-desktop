/**
 * Client half: a bottom-left footer entry (above Settings) that asks the Host to
 * build/refresh the WSL Desktop proxy copy and launch it.
 *
 * Once the copy is actually running, the entry shows "WSL 窗口运行中" and stays
 * clickable: a second launch of the copy hits its single-instance lock and
 * brings the open WSL window to the front. The current window never becomes the
 * WSL one — its Host address is fixed at startup — so the entry must not claim
 * "WSL mode" for it.
 *
 * @module @karoy/dsh-wsl-desktop/client
 */
window.__ModuleLoader__.load({
  id: '@karoy/dsh-wsl-desktop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
.dsh-wsl-desktop-footer{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:32px;width:100%;padding:0;
  border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;
  cursor:pointer;opacity:.85;white-space:nowrap;transition:opacity .12s,background .12s}
.dsh-wsl-desktop-footer[data-wide=true]{justify-content:flex-start;padding:0 10px}
.dsh-wsl-desktop-footer:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-wsl-desktop-footer[data-state=running]{opacity:.9}
.dsh-wsl-desktop-footer:focus-visible{outline:2px solid color-mix(in srgb,currentColor 45%,transparent);outline-offset:2px}
.dsh-wsl-desktop-footer:disabled{opacity:.45;cursor:default}
.dsh-wsl-desktop-footer[data-state=error]{color:#e5534b}
.dsh-wsl-desktop-badge{display:inline-flex;align-items:center;gap:7px;height:32px;width:100%;padding:0 10px;
  font:inherit;font-size:12px;line-height:1;white-space:nowrap;user-select:none;cursor:default;
  color:color-mix(in srgb,currentColor 58%,transparent)}
.dsh-wsl-desktop-badge[data-wide=false]{justify-content:center;padding:0}
.dsh-wsl-desktop-badge .dsh-wsl-dot{flex:none;width:6px;height:6px;border-radius:50%;background:#2ea043;
  box-shadow:0 0 0 3px color-mix(in srgb,#2ea043 16%,transparent)}
.dsh-wsl-desktop-badge .dsh-wsl-badge-label{overflow:hidden;text-overflow:ellipsis}
.dsh-wsl-desktop-footer[data-state=busy]{cursor:progress;opacity:1}
.dsh-wsl-desktop-footer[data-state=busy] svg{animation:dsh-wsl-spin 1.1s linear infinite;transform-origin:50% 50%}
.dsh-wsl-desktop-footer .dsh-wsl-ellipsis{opacity:.55;font-size:11px;font-variant-numeric:tabular-nums}
@keyframes dsh-wsl-spin{to{transform:rotate(360deg)}}
.dsh-wsl-target{position:fixed;z-index:80;width:300px;max-height:60vh;overflow:auto;padding:6px;border-radius:10px;
  border:1px solid color-mix(in srgb,CanvasText 16%,transparent);background:Canvas;color:CanvasText;
  box-shadow:0 12px 32px rgba(0,0,0,.22);font-size:12px}
.dsh-wsl-target-head{display:flex;align-items:center;justify-content:space-between;padding:4px 8px;opacity:.65;
  font-size:11px;letter-spacing:.02em;text-transform:uppercase}
.dsh-wsl-target-refresh{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:11px;
  padding:2px 6px;border-radius:4px;opacity:.9}
.dsh-wsl-target-refresh:hover{background:color-mix(in srgb,CanvasText 10%,transparent)}
.dsh-wsl-target-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:6px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap}
.dsh-wsl-target-row[data-active=true]{background:color-mix(in srgb,CanvasText 10%,transparent)}
.dsh-wsl-target-row:disabled{opacity:.5;cursor:default}
.dsh-wsl-target-check{flex:none;width:14px;opacity:.9}
.dsh-wsl-target-name{flex:1;overflow:hidden;text-overflow:ellipsis}
.dsh-wsl-target-state{flex:none;font-size:10px;padding:1px 5px;border-radius:4px;
  background:color-mix(in srgb,CanvasText 10%,transparent);opacity:.8}
.dsh-wsl-target-empty{padding:8px;opacity:.6}
.dsh-wsl-target-hint{padding:4px 8px;color:#c69026;font-size:11px;white-space:normal}
`

    function DesktopIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 8.6, rx: 1.4 }),
      h('path', { d: 'M5.6 13.6h4.8M8 11v2.6' }),
      h('path', { d: 'M4.4 5.2l1.8 1.5-1.8 1.5M7.8 8.2h2.6' }))
    }

    /**
     * Host state: `running` = the copy process is alive (a separate WSL window);
     * `auto` = the last helper run (`{ ok: null | true | false, steps, error }`),
     * where `ok === null` means the helper is still working.
     */
    async function readState() {
      const res = await fetch('/wsl-desktop/state', { headers: { accept: 'application/json' } })
      const data = await res.json().catch(() => null)
      return {
        running: data?.ok === true && data.running === true,
        auto: data?.auto ?? null,
      }
    }

    async function openDesktop() {
      const res = await fetch('/wsl-desktop/open', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      })
      let data
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (data?.ok !== true) throw new Error(data?.error || `request failed (${res.status})`)
    }

    /** Which side is serving this page: the Windows Host or a WSL Host. */
    let modePromise = null
    function readMode() {
      if (modePromise === null) {
        modePromise = fetch('/wsl-desktop/mode', { headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => null))
          .then((data) => (data?.ok === true && typeof data.mode === 'string' ? data.mode : 'windows'))
          .catch(() => 'windows')
      }
      return modePromise
    }

    function useMode() {
      const [mode, setMode] = React.useState(null)
      React.useEffect(() => { readMode().then(setMode, () => setMode('windows')) }, [])
      return mode
    }

    function WslDesktopFooter({ wide }) {
      const [phase, setPhase] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const [copy, setCopy] = React.useState({ running: false, auto: null })
      const [startedAt, setStartedAt] = React.useState(0)
      const [now, setNow] = React.useState(Date.now())
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [menuAnchor, setMenuAnchor] = React.useState(null)
      const [distros, setDistros] = React.useState([])
      const [currentDistro, setCurrentDistro] = React.useState('')
      const [menuLoading, setMenuLoading] = React.useState(false)
      const [menuError, setMenuError] = React.useState('')
      const [menuHint, setMenuHint] = React.useState('')
      const [active, setActive] = React.useState(0)
      const buttonRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const mode = useMode()

      const reveal = React.useCallback(() => {
        readState().then(setCopy, () => setCopy({ running: false, auto: null }))
      }, [])

      const auto = copy.auto
      const autoAt = auto === null ? Number.NaN : Date.parse(String(auto.at ?? ''))
      const autoFresh = !Number.isFinite(autoAt) ? true : Date.now() - autoAt < 15 * 60 * 1000
      const preparing = !copy.running && (phase === 'preparing' || (auto?.ok === null && autoFresh))
      const busy = phase === 'preparing'

      const startPreparing = () => {
        setPhase('preparing')
        setDetail('')
        setStartedAt(Date.now())
        setNow(Date.now())
      }

      const items = [{ name: '', label: '默认发行版', state: '' }].concat(distros)

      const loadDistros = () => {
        setMenuLoading(true)
        setMenuError('')
        fetch('/wsl-desktop/distros', { headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => null))
          .then((data) => {
            if (data?.ok !== true) throw new Error(data?.error ?? '无法读取 WSL 发行版')
            setDistros(Array.isArray(data.distros) ? data.distros : [])
            setCurrentDistro(typeof data.current === 'string' ? data.current : '')
            setActive(0)
          })
          .catch((error) => setMenuError(error instanceof Error ? error.message : String(error)))
          .finally(() => setMenuLoading(false))
      }

      const openMenu = () => {
        if (menuOpen) {
          setMenuOpen(false)
          return
        }
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect()
        if (rect !== null) {
          const width = 300
          setMenuAnchor({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
          })
        }
        setMenuOpen(true)
        setMenuHint('')
        loadDistros()
      }

      const openAsCurrent = (name) => {
        if (copy.running && name !== currentDistro) {
          setMenuHint('当前 WSL 窗口已打开：先关闭它，再切换目标')
          return
        }
        setMenuOpen(false)
        if (copy.running) {
          openDesktop().catch((error) => console.warn('[wsl-desktop]', error))
          return
        }
        startPreparing()
        fetch('/wsl-desktop/select', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ distro: name }),
        })
          .then((res) => res.json().catch(() => null))
          .then((data) => {
            if (data?.ok !== true) throw new Error(data?.error ?? '切换目标失败')
            setCurrentDistro(name)
            setTimeout(reveal, 800)
          })
          .catch((error) => {
            console.warn('[wsl-desktop]', error)
            setDetail(error instanceof Error ? error.message : String(error))
            setPhase('error')
          })
      }

      React.useEffect(() => {
        // The effect runs even when the render below returns the WSL badge, so
        // gate the copy poll on the platform: the WSL side has no such route.
        if (mode !== 'windows') return undefined
        reveal()
        const timer = setInterval(reveal, preparing ? 1500 : 10000)
        const onFocus = () => reveal()
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [mode, preparing, reveal])

      React.useEffect(() => {
        if (!preparing) return undefined
        const tick = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(tick)
      }, [preparing])

      React.useEffect(() => {
        if (copy.running) {
          setPhase('idle')
          return
        }
        if (auto === null) return
        const at = Date.parse(String(auto.at ?? ''))
        const fresh = Number.isFinite(at) ? Date.now() - at < 15 * 60 * 1000 : true
        if (auto.ok === false && fresh) {
          setPhase('error')
          setDetail(String(auto.error ?? '准备失败'))
          return
        }
        if (auto.ok === true && phase !== 'idle') setPhase('idle')
      }, [copy.running, auto, phase])

      React.useEffect(() => {
        if (phase !== 'preparing') return undefined
        const timer = setTimeout(() => {
          setPhase('error')
          setDetail('准备超时（10 分钟）')
        }, 10 * 60 * 1000)
        return () => clearTimeout(timer)
      }, [phase, startedAt])

      React.useEffect(() => {
        if (!menuOpen) return undefined
        const onDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(event.target)) return
          setMenuOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setMenuOpen(false)
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((index) => Math.min(items.length - 1, index + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(0, index - 1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const item = items[active]
            if (item !== undefined) openAsCurrent(item.name)
          }
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [menuOpen, items, active])

      if (mode === 'wsl') {
        // The stylesheet is injected by the Windows footer otherwise; the badge
        // branch must bring its own copy or the class resolves to no styles.
        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', {
            className: 'dsh-wsl-desktop-badge',
            'data-wide': wide ? 'true' : 'false',
            title: '当前窗口是 WSL 副本：DSH Host 运行在 WSL 里；shell 在右侧栏的终端标签',
          },
          h(DesktopIcon, { size: 15 }),
          wide ? h('span', { className: 'dsh-wsl-dot' }) : null,
          wide ? h('span', { className: 'dsh-wsl-badge-label' }, 'WSL 副本') : null))
      }

      const elapsed = startedAt > 0 ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0
      const lastStep = Array.isArray(auto?.steps) && auto.steps.length > 0 ? auto.steps[auto.steps.length - 1] : ''

      const onClick = () => {
        if (menuOpen) {
          setMenuOpen(false)
          return
        }
        if (busy) return
        startPreparing()
        openDesktop().then(
          () => { setTimeout(reveal, 800) },
          (error) => {
            console.warn('[wsl-desktop]', error)
            setDetail(error instanceof Error ? error.message : String(error))
            setPhase('error')
          },
        )
      }

      const label = copy.running
        ? 'WSL 窗口运行中'
        : phase === 'preparing'
          ? '准备中…'
          : phase === 'error'
            ? '启动失败'
            : '从WSL打开'
      const title = copy.running
        ? '左键：把已打开的 WSL 窗口带到前台；右键：选择目标发行版'
        : phase === 'preparing'
          ? '正在准备' + (lastStep === '' ? '' : '：' + lastStep) + '（已 ' + String(elapsed) + 's）；右键：选择目标发行版'
          : phase === 'error'
            ? '启动失败：' + detail + '；右键：选择目标发行版'
            : '左键：在 WSL 中打开 DSH 桌面窗口；右键：选择目标发行版'
      const buttonState = copy.running ? 'running' : phase === 'error' ? 'error' : phase === 'preparing' ? 'busy' : 'idle'

      const menu = menuOpen && menuAnchor !== null
        ? h('div', {
          className: 'dsh-wsl-target',
          role: 'menu',
          'aria-label': 'WSL 目标',
          ref: menuRef,
          style: { left: String(menuAnchor.left) + 'px', bottom: String(menuAnchor.bottom) + 'px' },
        },
        h('div', { className: 'dsh-wsl-target-head' },
          h('span', null, 'WSL 目标'),
          h('button', {
            type: 'button',
            className: 'dsh-wsl-target-refresh',
            disabled: menuLoading,
            onClick: loadDistros,
          }, menuLoading ? '刷新中…' : '刷新')),
        menuError === '' ? null : h('div', { className: 'dsh-wsl-target-empty' }, menuError),
        menuLoading && distros.length === 0 ? h('div', { className: 'dsh-wsl-target-empty' }, '读取中…') : null,
        ...items.map((item, index) => h('button', {
          key: item.name === '' ? 'default' : item.name,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': item.name === currentDistro,
          className: 'dsh-wsl-target-row',
          'data-active': index === active ? 'true' : 'false',
          onMouseEnter: () => setActive(index),
          onClick: () => openAsCurrent(item.name),
        },
        h('span', { className: 'dsh-wsl-target-check' }, item.name === currentDistro ? '✓' : ''),
        h('span', { className: 'dsh-wsl-target-name' }, item.label ?? item.name),
        item.state === '' || item.state === undefined ? null : h('span', { className: 'dsh-wsl-target-state' }, item.state),
        item.default === true && item.name !== '' ? h('span', { className: 'dsh-wsl-target-state' }, '默认') : null)),
        menuHint === '' ? null : h('div', { className: 'dsh-wsl-target-hint' }, menuHint))
        : null

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          ref: buttonRef,
          className: 'dsh-wsl-desktop-footer',
          'data-wide': wide ? 'true' : 'false',
          'data-state': buttonState,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          title,
          'aria-label': label + '：' + title,
          disabled: busy,
          onClick,
          onContextMenu: (event) => {
            event.preventDefault()
            openMenu()
          },
          onKeyDown: (event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              openMenu()
            }
          },
        },
        h(DesktopIcon, { size: 15 }),
        wide ? h('span', null, label) : null,
        phase === 'preparing' && wide ? h('span', { className: 'dsh-wsl-ellipsis' }, String(elapsed) + 's') : null),
        menu)
    }

    const SETTINGS_CSS = `
.dsh-wsl-settings{display:flex;flex-direction:column;gap:14px;font-size:13px}
.dsh-wsl-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-wsl-settings-label{display:flex;flex-direction:column;gap:2px}
.dsh-wsl-settings-label small{color:color-mix(in srgb,currentColor 60%,transparent);font-size:12px}
.dsh-wsl-settings input[type=text],.dsh-wsl-settings input[type=number],.dsh-wsl-settings select{width:220px;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;font:inherit}
.dsh-wsl-settings-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-wsl-settings button{padding:4px 12px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;font:inherit;cursor:pointer}
.dsh-wsl-settings button[data-primary=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.dsh-wsl-settings button:disabled{opacity:.45;cursor:default}
.dsh-wsl-settings .dsh-wsl-settings-note{color:#e5534b;font-size:12px;margin:0}
.dsh-wsl-settings .dsh-wsl-settings-saved{color:color-mix(in srgb,currentColor 70%,transparent);font-size:12px;margin:0}
.dsh-wsl-doctor{display:flex;flex-direction:column;gap:4px;font-size:12px}
.dsh-wsl-doctor-row{display:flex;gap:8px;align-items:baseline}
.dsh-wsl-doctor-row[data-state=warn]{color:#c69026}
.dsh-wsl-doctor-row[data-state=fail]{color:#e5534b}
.dsh-wsl-doctor-name{flex:none;width:64px;opacity:.8}
`

    const SETTINGS_FIELDS = [
      { key: 'mode', label: '模式', help: 'proxy 保留桌面外壳；direct 主窗口直接加载 WSL 页面', kind: 'select', options: [['proxy', 'proxy'], ['direct', 'direct']] },
      { key: 'port', label: '端口', help: 'WSL 内 DSH Host 的端口', kind: 'number', min: 1, max: 65535 },
      { key: 'distro', label: '发行版', help: '留空使用 WSL 默认发行版', kind: 'text' },
      { key: 'autoInstall', label: '自动安装运行时', help: 'WSL 缺少 Node/DSH 时自动安装', kind: 'boolean' },
      { key: 'autoSetup', label: '自动准备副本', help: '副本缺失、模式变化或 Desktop 升级时重建', kind: 'boolean' },
      { key: 'autoRun', label: '启动时自动准备', help: 'DSH 启动后自动跑一次准备（不启动窗口）', kind: 'boolean' },
      { key: 'autoLaunch', label: '准备后自动启动', help: '准备完成后直接打开 WSL 窗口', kind: 'boolean' },
      { key: 'syncWslPlugins', label: '同步插件', help: '首次初始化时把 Windows 插件镜像到 WSL', kind: 'boolean' },
      { key: 'syncLinked', label: '同步 link 插件', help: '包含 link: 安装的插件（默认跳过）', kind: 'boolean' },
      { key: 'autoDelayMs', label: '准备延迟 (ms)', help: 'DSH 启动后等待多久开始准备', kind: 'number', min: 0 },
      { key: 'installDir', label: '副本目录', help: '留空使用 %LOCALAPPDATA%\\DeepSeek Harness WSL Desktop', kind: 'text' },
      { key: 'userDataDirName', label: 'Electron profile 名', help: '副本使用的独立 userData 目录名', kind: 'text' },
    ]

    const SETTINGS_SECTION_ID = 'wsl-desktop'

    /**
     * The plugin's page inside DSH Settings: reads and writes the row config
     * through the Host's `/wsl-desktop/config` route, which persists the values
     * in the profile patch with the config editor.
     */
    /** WSL side: read-only state of the Host running inside WSL + shell toggle. */
    function WslSideSettings() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(() => {
        fetch('/wsl-desktop/wsl-state', { headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => null))
          .then((data) => {
            if (data?.ok === true) { setState(data); setError('') } else setError('无法读取 WSL 状态')
          })
          .catch((thrown) => setError(thrown instanceof Error ? thrown.message : String(thrown)))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const enableShell = async () => {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const res = await fetch('/wsl-desktop/wsl-shell', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: '{}',
          })
          const data = await res.json().catch(() => null)
          if (data?.ok === true) {
            setNote(data.added ? '已启用：重开这个 WSL 窗口后，右侧栏出现终端标签' : '终端已启用：右侧栏的终端标签就是 WSL 里的 shell')
            refresh()
          } else {
            setError(data?.error ?? '启用失败（HTTP ' + res.status + '）')
          }
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown))
        } finally {
          setBusy(false)
        }
      }

      const rows = [
        ['运行模式', 'WSL 副本（Host 在 WSL 内）'],
        ['Host', state === null ? '…' : 'pid ' + String(state.pid) + ' · 端口 ' + String(state.port ?? '?')],
        ['用户目录', state === null ? '…' : String(state.home)],
        ['.env', state === null ? '…' : state.envFile ? '已就绪' : '缺失'],
        ['凭据', state === null ? '…' : state.credentials ? '已就绪' : '缺失'],
        ['终端 bundle', state === null ? '…' : state.terminal ? '已启用（右侧栏终端标签）' : '未启用'],
      ]

      return h('div', { className: 'dsh-wsl-settings' },
        h('style', null, SETTINGS_CSS),
        ...rows.map(([label, value]) => h('div', { className: 'dsh-wsl-settings-row', key: label },
          h('div', { className: 'dsh-wsl-settings-label' }, h('span', null, label)),
          h('span', null, String(value)))),
        state !== null && state.terminal === false
          ? h('div', { className: 'dsh-wsl-settings-actions' },
            h('button', { type: 'button', 'data-primary': 'true', disabled: busy, onClick: enableShell },
              busy ? '启用中…' : '启用终端 bundle'))
          : null,
        error === '' ? null : h('p', { className: 'dsh-wsl-settings-note' }, error),
        note === '' ? null : h('p', { className: 'dsh-wsl-settings-saved' }, note))
    }

    function WslDesktopSettingsSection() {
      const mode = useMode()
      if (mode === null) return h('p', null, '…')
      if (mode === 'wsl') return h(WslSideSettings)
      return h(WindowsSettings)
    }

    function WindowsSettings() {
      const [draft, setDraft] = React.useState(null)
      const [base, setBase] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [report, setReport] = React.useState(null)
      const [checking, setChecking] = React.useState(false)
      const [reportError, setReportError] = React.useState('')

      const refresh = React.useCallback(() => {
        fetch('/wsl-desktop/config', { headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => null))
          .then((data) => {
            setLoading(false)
            if (data?.ok === true && data.config !== undefined) {
              setDraft({ ...data.config })
              setBase({ ...data.config })
            } else {
              setError('无法读取配置')
            }
          })
          .catch((thrown) => { setError(thrown instanceof Error ? thrown.message : String(thrown)); setLoading(false) })
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      if (loading) return h('p', null, '读取配置…')
      if (draft === null || base === null) {
        return h('p', { className: 'dsh-wsl-settings-note' }, error === '' ? '配置暂不可用' : error)
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(base)
      const disabled = saving

      const save = async () => {
        setSaving(true)
        setError('')
        setSaved('')
        try {
          const res = await fetch('/wsl-desktop/config', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          })
          const data = await res.json().catch(() => null)
          if (res.ok && data?.ok === true && data.config !== undefined) {
            setBase({ ...data.config })
            setDraft({ ...data.config })
            setSaved('已保存')
          } else {
            setError(data?.error ?? '保存失败（HTTP ' + res.status + '）')
          }
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown))
        } finally {
          setSaving(false)
        }
      }

      const rows = SETTINGS_FIELDS.map((field) => {
        const current = draft[field.key]
        const id = 'wsl-desktop-' + field.key
        let control
        if (field.kind === 'boolean') {
          control = h('input', {
            id, type: 'checkbox', checked: current === true, disabled,
            onChange: (event) => setDraft({ ...draft, [field.key]: event.target.checked }),
          })
        } else if (field.kind === 'select') {
          control = h('select', {
            id, value: current ?? '', disabled,
            onChange: (event) => setDraft({ ...draft, [field.key]: event.target.value }),
          }, field.options.map(([option, label]) => h('option', { key: option, value: option }, label)))
        } else {
          control = h('input', {
            id, type: field.kind === 'number' ? 'number' : 'text',
            value: current ?? '', disabled, min: field.min, max: field.max,
            onChange: (event) => setDraft({
              ...draft,
              [field.key]: field.kind === 'number' ? Number(event.target.value) : event.target.value,
            }),
          })
        }
        return h('div', { className: 'dsh-wsl-settings-row', key: field.key },
          h('label', { className: 'dsh-wsl-settings-label', htmlFor: id },
            h('span', null, field.label),
            field.help ? h('small', null, field.help) : null),
          control)
      })

      const runDoctor = async () => {
        setChecking(true)
        setReportError('')
        try {
          const res = await fetch('/wsl-desktop/doctor', { headers: { accept: 'application/json' } })
          const data = await res.json().catch(() => null)
          if (Array.isArray(data?.checks)) setReport(data.checks)
          else setReportError(data?.error ?? '诊断失败（HTTP ' + res.status + '）')
        } catch (thrown) {
          setReportError(thrown instanceof Error ? thrown.message : String(thrown))
        } finally {
          setChecking(false)
        }
      }

      return h('div', { className: 'dsh-wsl-settings' },
        h('style', null, SETTINGS_CSS),
        ...rows,
        error === '' ? null : h('p', { className: 'dsh-wsl-settings-note' }, error),
        saved === '' ? null : h('p', { className: 'dsh-wsl-settings-saved' }, saved),
        h('div', { className: 'dsh-wsl-settings-actions' },
          h('button', {
            type: 'button', disabled: disabled || !dirty,
            onClick: () => { setDraft({ ...base }); setError(''); setSaved('') },
          }, '还原'),
          h('button', { type: 'button', 'data-primary': 'true', disabled: disabled || !dirty, onClick: save }, saving ? '保存中…' : '保存')),
        h('div', { className: 'dsh-wsl-settings-actions' },
          h('button', { type: 'button', disabled: checking, onClick: runDoctor }, checking ? '诊断中…' : '运行诊断')),
        reportError === '' ? null : h('p', { className: 'dsh-wsl-settings-note' }, reportError),
        report === null ? null : h('div', { className: 'dsh-wsl-doctor' },
          ...report.map((check) => h('div', { className: 'dsh-wsl-doctor-row', 'data-state': check.state, key: check.name },
            h('span', { className: 'dsh-wsl-doctor-name' }, check.name),
            h('span', null, check.detail)))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'wsl-desktop',
          order: 4,
        }, WslDesktopFooter))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: 200,
          label: () => 'WSL 桌面',
        }, WslDesktopSettingsSection))
      },
    }
  },
})