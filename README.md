# @karoy/dsh-wsl-desktop

让 **DSH Desktop 窗口本身**跑在 WSL 里的 DSH Host 上（proxy 模式，保留「应用/编辑」外壳），
或让主窗口直接加载 WSL Host 页面（direct 模式）。全程只动**副本**，原安装不修改。

## 使用

安装后（一次），之后**完全自动 + 按需启动**：

- **程序启动时**：只做环境准备——
  1. 副本缺失 / 模式变了 / Desktop 升级 → 重建副本（robocopy → 解包 asar → 打 proxy 补丁）；
  2. **每次启动/每次点「从WSL打开」**（`syncWslPlugins` 开启时，默认开）都会把 Windows desktop profile 的插件状态镜像到 WSL：
     启用的 → 安装并启用；禁用的 → 安装但保持禁用；配置行（id/name/enabled/config）同步；
     有变化且副本没开 → 重启 WSL Host 让新插件生效；副本开着 → 只写 profile，提示重开窗口生效；
  3. **不启动应用**。
- **左键点左下角「从WSL打开」**：按当前目标启动 proxy 版桌面窗口（环境已就绪，秒级）。
- **右键点同一个入口**（或键盘 ContextMenu / Shift+F10）：弹出 WSL 目标列表，列出本机发行版
  （Running/Stopped、当前 ✓、默认标记）；选一行即切换目标并打开，之后左键沿用该目标。
- **副本已在运行时**：入口显示「WSL 窗口运行中」，仍可点击——点击会把已打开的 WSL 窗口带到前台
  （副本再次启动触发 Electron 单实例聚焦）。当前窗口本身不会变成 WSL，切换只发生在副本里。
- WSL 侧手动启停的插件会被下一次镜像覆盖；不想被覆盖就关掉 `syncWslPlugins`。

命令只作兜底：

| 命令 | 作用 |
| --- | --- |
| `/wsl-desktop-status` | 副本状态、模式、WSL Host 的 pid/端口/是否过期、上次准备/启动结果 |
| `/wsl-desktop-restart` | 停掉 WSL Host，下次打开会用最新的 .env / profile / 凭据重启 |
| `/wsl-desktop-terminal` | 在 WSL profile 启用官方终端 bundle：WSL 窗口右侧栏出现可交互的 shell 标签 |
| `/wsl-desktop-doctor` | 体检：WSL runtime、Host 是否过期、`.env`/凭据、网关密钥、包管理器 store、终端 bundle |
| `/wsl-desktop-launch` | 立即启动副本 |
| `/wsl-desktop-sync` | 手动重跑一次完整镜像（启用+禁用+配置） |
| `/wsl-desktop-setup` | 手动重建副本 |
| `/wsl-desktop-remove` | 删除副本与独立 Electron profile |

## 配置

装好后 DSH **设置 → WSL 桌面** 里就是配置页（与语音输入等插件同一套 `settings.section`）：改动点保存，
写回 profile 的 `cordis.patch.yml`（走 DSH 的 config editor），插件会重启并用新值；改 `mode` 会在下一次
准备时重建副本。也可以直接写 profile patch 的 `config`（留空按默认）。

- `mode`: `"proxy"`（默认，保留桌面外壳）｜`"direct"`（主窗口直接加载 WSL 页面）
- `installDir`：可选覆盖；默认 `%LOCALAPPDATA%\DeepSeek Harness WSL Desktop`（不写死盘符）
- `userDataDirName`（默认 `DeepSeek Harness WSL`）
- `port` / `distro` / `autoInstall`：WSL Host 参数（默认 3080 / 默认发行版 / 自动装 runtime）
- `autoRun` / `autoSetup` / `autoLaunch` / `syncWslPlugins` / `syncLinked` / `autoDelayMs`
  （默认 `true / true / false / true / false / 4000`：自动准备、**不自动启动**）

## 原理

1. `robocopy` 复制整个安装目录到 `installDir`，副本里解包 `app.asar`（原 asar 备份 `.orig`）；
2. 补丁 `lib/main.js`（带 `DSH_WSL_DESKTOP` 标记、可重复）：
   - proxy：`host.start()` 后把 `ready.url` 换成 WSL Host 的 token URL；认证后拉取 WSL Host
     的 `/` HTML，解析其 index 注入表（插件图、`rev`、全局配置）替换 `ready.injections`，
     否则桌面壳的 `/plugins/??…&rev=…` 与 WSL rev 对不上会 404；
   - direct：主窗口 `navigateMain` 直接指 WSL URL；
3. 写入 `lib/wsl-remote.cjs`：WSL 内装 runtime、启动/复用 Host、读出 `dsh web:` URL；
   Host 用 `bash -lis`（交互式登录 shell）启动，`~/.bashrc` / `~/.profile` 里的环境变量因此生效；
   DSH 自己在启动时照常加载 WSL 的 `~/.dsh/.env`。每次打开窗口时按“配置戳”判断：`.env`、
   凭据、profile patch、shell rc 里有任何比上次启动后更晚被写过的，就会重启 Host 再连
   （戳是等启动期那几秒的自动重写稳定后记下的，启动期改写不会造成误重启）。
   关闭窗口**不会**停 Host（它是 `setsid` 脱离进程组的），所以改完配置要点
   `/wsl-desktop-restart` 或重开窗口才会生效；`/wsl-desktop-status` 会告诉你 Host 是否过期。
   Host 的 pid 以实际监听端口为准（`setsid` 可能换 pid），找不到 pid 时从日志 + `ss` 找回
   正在运行的 Host，避免重复启动；切换外壳前还会等 WSL URL 在 Windows 侧真正可连
   （约 10s 上限），躲开启动竞态；
4. 独立 `DSH_HOME` + 独立 userData，与主应用完全隔离；
5. helper 通过隐藏 spawn（`CREATE_NO_WINDOW`，无黑框）后台执行。

## 两侧行为

同一份包按 `process.platform` 分两侧，`GET /wsl-desktop/mode` 把结果告诉客户端
（`{ platform, mode: 'windows' | 'wsl' }`）：

| | Windows 侧 | WSL 侧（WSL Host 内） |
|---|---|---|
| 页脚 | 「从WSL打开」（已运行时「WSL 窗口运行中」） | 只读「WSL 副本」标识 |
| 设置页 | 副本配置表单（模式/端口/同步…） | WSL 状态：Host pid/端口、用户目录、`.env`/凭据、终端 bundle；可一键启用终端 |
| 命令 | setup / launch / open / remove / status / restart / terminal / sync | `/wsl-shell`（启用右侧栏终端 bundle） |
| Host | 自动准备、镜像插件、启动副本 | 不自动运行、不碰 Windows 路径 |

因此 `@karoy/dsh-wsl-desktop` 自己也可以按 `link:` 同步进 WSL（`syncLinked: true`）。

## 首次初始化同步的内容

以 Windows desktop profile 为源：

| Windows 状态 | WSL 处理 |
|---|---|
| 启用的插件 | `dsh plugin add` 安装 + 进 WSL bundles（启用），配置行合并 |
| 禁用的插件 | 同样安装依赖，但**不进 bundles**，配置行 `enabled: false` |
| link 插件 | 默认跳过（`syncLinked: true` 时按 `/mnt/<盘>/…` 同步）；装不上就不启用，并清掉旧的坏 bundle 引用 |
| file: tgz | 跳过（Windows 本地归档在 WSL 无意义） |

同步完成后写 `.dsh-wsl-initialized` 戳；同步只在 `syncWslPlugins` 开启时按上面的时机执行。

## 限制

- 「从WSL打开」不会把当前窗口切换成 WSL：原窗口的 Host 地址在启动时就固定了（`app.asar/lib/main.js`
  的模块作用域变量），插件改不了它；只有另起的补丁副本是 WSL 的。副本运行后入口显示
  「WSL 窗口运行中」，点击只负责把它带到前台。
- proxy 模式的工作区选择等目录操作走 WSL Host 的 browse 选择器（外壳的原生目录对话框
  未接到 WSL 侧）；「应用/编辑」菜单与窗口外壳保留。
- 会话、凭据、工作区都是 WSL 自己的；WSL 的 `~/.dsh` 与 Windows 的互不相干。
- 应用升级会覆盖副本补丁；升级后下次启动自动重建副本（不重同步），可 `/wsl-desktop-sync`。

## 发布

仓库的 `NPM_TOKEN` 具备直接发布权限：

1. 改 `package.json` 的 `version`，提交并 push；
2. 在 GitHub 创建 **Release**（发布）→ `Publish to npm` 工作流先跑 CI，再执行
   `npm publish --access public`；
3. 验证：`npm view @karoy/dsh-wsl-desktop version`（当前 `0.1.1`）。
## 回滚

`/wsl-desktop-remove`，或关闭窗口后删除 `installDir` 与 `%APPDATA%\DeepSeek Harness WSL`。