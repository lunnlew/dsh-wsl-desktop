# WSL 桌面：实现细节

这个插件让 DSH Desktop 的窗口跑在 **WSL 里的 DSH Host** 上，同时不改动原安装的任何文件。

## 组成

1. **副本（Windows 侧）**
   `robocopy` 把安装目录整体复制到 `%LOCALAPPDATA%\DeepSeek Harness WSL Desktop`，在副本里解包
   `app.asar`（原 asar 不动），给 `lib/main.js` 打补丁：
   - `proxy`（默认）：保留桌面外壳，`host.start()` 后把 `ready.url` 换成 WSL Host 的 token URL；
     认证后拉取 WSL Host 的 `/` HTML，用它注入表替换 `ready.injections`，让插件图与
     `/plugins/??…&rev=…` 对得上；
   - `direct`：主窗口直接导航到 WSL URL。
2. **WSL 侧**
   - 启动/复用 `dsh --profile web --no-open --port <port>`，用 `bash -lis` 启动，使 `~/.bashrc`
     / `~/.profile` 生效；DSH 自己照常加载 `~/.dsh/.env`；
   - pid 以实际监听端口为准（`setsid` 会换 pid），找不到就从日志 + `ss` 找回；
   - 每次打开窗口按“配置戳”重开 Host：`.env`、`.credentials.yaml`、profile patch、shell rc
     有更新就重启（戳在启动期自动重写稳定后写入，避免启动期改写造成误重启）；
   - 关闭窗口不会停 Host（`setsid` 脱离进程组），要立刻生效用 `/wsl-desktop-restart`。
3. **两侧行为**
   同一个包按 `process.platform` 分侧，`GET /wsl-desktop/mode` 告诉客户端：
   - Windows：副本配置、`/wsl-desktop/open`、页脚「从WSL打开」；
   - WSL：`/wsl-desktop/wsl-state`、`/wsl-desktop/wsl-shell`，页脚是只读徽标，设置页显示
     Host pid/端口、`.env`/凭据、终端 bundle 状态。

## 插件同步

`syncWslPlugins`（默认开）在每次启动/打开窗口时把 Windows desktop profile 的插件镜像到 WSL：
启用的安装并启用、禁用的安装但保持禁用、配置行合并；`syncLinked` 决定是否包含 `link:` 插件
（默认跳过，因为 `/mnt/<盘>` 是 9P，慢且依赖目标目录自己的 `node_modules`）。
安装失败的插件不会被启用，旧的坏 bundle 引用会被清掉。

## 诊断

`/wsl-desktop-doctor`（或设置页的「运行诊断」）逐项检查：WSL runtime、Host 是否在跑/是否比配置旧、
`~/.dsh/.env` 里的网关密钥、`.credentials.yaml` 的 ref 是否与 `.env` 不一致（ref 优先，会静默盖掉
`.env`）、网关对该密钥的应答（200/401/403）、profile 的包管理器 store 是否与当前一致、
终端 bundle 是否启用，以及副本是否需要重建。

## 常见问题

- **网关拒绝密钥**：`.credentials.yaml` 里的 `refs` 优先于 `.env`，过期的 ref 会盖掉 `.env`
  的当前值；删掉对应的 ref 让 `.env` 生效，再用 `/wsl-desktop-restart` 重开 Host。
- **插件安装报 store 不一致**：profile 的 `node_modules` 由某个包管理器大版本链接，而 DSH
  现在用的是另一个。在 profile 目录里用 DSH 实际使用的那一个重装依赖即可。
- **没有终端**：`/wsl-desktop-terminal` 在 WSL profile 里启用官方 terminal bundle；之后右侧栏
  出现 shell 标签（WSL 里的 bash）。

## 文件

| 路径 | 作用 |
| --- | --- |
| `index.js` | 插件入口：两侧行为、路由、命令 |
| `client.js` | 客户端：页脚、设置页（按 `/wsl-desktop/mode` 分支） |
| `lib/setup.js` | 副本构建与 `main.js` 补丁 |
| `lib/wsl-remote.cjs` | WSL Host 的启动/复用/配置戳 |
| `lib/sync.js` | 插件镜像、Host 状态、终端 bundle |
| `bin/auto.mjs` | 后台 helper（单实例锁、准备、同步、启动） |
