# Spec: WSL 目标选择器 — V1

## Objective

左下角的「从WSL打开」现在一点就直接按配置里的 `distro` 启动副本。多发行版机器上，用户只能去设置页改
`distro` 再回来点，且不知道有哪些发行版可用。

本版本采用 VS Code 远程开发的分工：**左键点击 = 用当前目标直接打开；右键 = 弹出目标列表**。列表列出已安装
的 WSL 发行版（名称、运行状态、当前目标、默认项），选一行即切换目标并打开。

成功的样子：日常一次左键就开（默认发行版）；需要换发行版时右键一下，选一个，副本按该发行版启动。

## 用户故事 / 验收标准

1. **左键点击入口**：沿用现有流程，按**当前目标**（初始为默认发行版）准备并打开副本；不弹列表。
2. **右键点击入口**（或键盘 ContextMenu / Shift+F10）：在按钮上方弹出目标列表，列出 `wsl.exe -l -v` 的
   全部发行版，含「默认发行版」一项。
3. 列表行显示：名称、状态（Running / Stopped）、当前目标（✓）、默认发行版标记。
4. 点击某行 → 持久化 `distro` 为该目标，随后触发一次打开（沿用现有的准备/启动状态机）。
5. 列表打开时点「刷新」→ 重新拉取发行版（新建的发行版立即可见）。
6. 列表可关闭：Esc、点外部、再次右键/点击入口。
7. 副本窗口已运行时：列表仍可打开；选择不同目标时不静默切换——给出「先关闭当前 WSL 窗口再切换」的提示。
8. 目标发行版里没有 DSH runtime 且 `autoInstall` 关闭时，启动状态机进入「启动失败」并显示原因（沿用现有失败展示）。
9. 键盘可达：列表有 `role="menu"`/`role="menuitemradio"` 语义，↑/↓ 移动、Enter 选择、Esc 关闭；
   入口的 `title`/`aria-description` 说明「左键打开，右键选择目标」。
10. 窄栏（只显示图标）与宽栏行为一致；右键在任何形态下都打开列表。

## Tech Stack

- 现有插件：纯 ESM Host（`index.js`）+ 手写客户端 bundle（`client.js`，无构建步骤，`require('react')`）。
- Host 侧通过 `spawnSync('wsl.exe', ['-l','-v'])` 读取发行版（UTF-16LE，需解码）。
- 配置持久化复用 `ctx.get('configEditor').edit(entry, …)`（与 `/wsl-desktop/config` 相同）。
- 无新增依赖。

## Commands

```
检查: node scripts/ci.mjs        # 语法 + manifest + exports/files 校验
发布: 打 tag → GitHub Release → Publish to npm workflow
手工验证: 打开任一会话 → 左下角入口左键（直接开）/右键（列表）
```

## Project Structure

```
index.js          → Host：路由（新增 /wsl-desktop/distros、/wsl-desktop/select）+ 入口命令
client.js         → 客户端：入口按钮（左键/右键分离）+ 目标列表弹出层
lib/doctor.js     → 体检（不改动；可后续把目标加入报告）
spec/             → 本规格
```

## Code Style

沿用仓库现状：无分号、单引号、2 空格缩进、行宽约 120；客户端组件用 `h()` 手写、样式内联在
`<style>` 字符串里（类名 `dsh-wsl-*`）。示例：

```js
const send = (status, body) => {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
```

## Testing Strategy

仓库没有单测框架；CI 是语法 + manifest 校验。本特性以**手工清单**为主，并在 CI 中保持语法通过：

- `wsl.exe -l -v` 解析：至少一台装有 2 个发行版的机器上验证名称/状态/默认标记；
- `-l -v` 不可用（老 WSL）时退化为 `-l -q`，列表可用、无状态；
- 左键：按当前目标打开，不弹列表；右键：弹列表；
- 键盘：ContextMenu / Shift+F10 打开列表，↑↓/Enter/Esc 可用；
- 副本运行中选择其他目标 → 提示而不切换；
- 选择后 `~/.dsh/profiles/desktop` 的插件配置里 `distro` 被持久化，重启 DSH 后仍在。

## Boundaries

- Always：改动前先读现有入口/状态机代码；保持无新增依赖；列表数据只在 Host 侧调用 `wsl.exe`；
  失败路径复用现有的「启动失败」状态，不吞错误；右键必须 `preventDefault`，不触发浏览器/Electron 默认菜单。
- Ask first：新增 npm 依赖；改变入口的默认点击行为（本规格已定：左键直接开、右键出列表）；
  需要重建副本的改动（`PATCH_VERSION`）或修改 `wsl-remote.cjs` 的启动约定。
- Never：在客户端直接调用 `wsl.exe`（浏览器环境）；把发行版列表硬编码；把 `wsl.exe -l -v`
  的输出不做 UTF-16 解码就解析。

## 数据与接口（提案）

`GET /wsl-desktop/distros`

```json
{
  "ok": true,
  "current": "Ubuntu-20.04",
  "distros": [
    { "name": "Ubuntu-20.04", "state": "Running", "default": true, "current": true },
    { "name": "Debian", "state": "Stopped", "default": false, "current": false },
    { "name": "", "state": "", "default": false, "current": false }
  ]
}
```

- `name: ""` 表示「默认发行版」（配置里 `distro` 为空时）。
- `-l -v` 不可用时只返回名称，`state` 为 `"unknown"`。

`POST /wsl-desktop/select`

```json
{ "distro": "Debian" }
```

行为：校验 `distro` 属于现有列表（或空字符串）→ 通过 config editor 持久化 → 触发一次
`runHelper({ ...cfg, distro, autoLaunch: true })` → 返回 `{ ok: true, at }`。客户端随后沿用现有的
准备/启动状态机（`/wsl-desktop/state` 的 `auto`）。

## Success Criteria

1. 左键点击入口：直接按**当前目标**启动，不弹列表；列表未用过时当前目标 = 默认发行版。
2. 右键（或 ContextMenu/Shift+F10）：弹出列表，内容与本机 `wsl.exe -l -v` 一致。
3. 在列表中选择某发行版后：插件配置 `distro` 持久化；副本按该发行版启动（`wsl.exe -d <distro>`），
   且此后左键沿用该目标。
4. 副本运行中选择不同目标：出现明确提示，不静默切换。
5. 列表可关闭、可刷新、键盘可达；窄栏（仅图标）与宽栏行为一致。
6. 现有打开流程（准备中/失败/运行中状态、超时提示）不回归。
7. `node scripts/ci.mjs` 通过；无新增依赖。

## Out of Scope (Deferred)

- 远程 SSH / 容器的目标列表（只做本机 WSL 发行版）。
- 每个发行版独立配置（端口、模式、同步开关）。
- 在副本运行中**自动**关闭窗口并切换目标（V1 只提示）。
- 目标列表里显示发行版版本号/磁盘占用/内核版本。
- 从列表直接「安装新发行版」。
- 长按/双击等额外手势（V1 只有左键与右键/键盘 ContextMenu）。

## Open Questions

1. 在列表里选了 Debian 之后，左键再点：按**当前目标（Debian）**打开（本规格默认），还是回到默认发行版？
2. 列表里点一行是否**立即打开**（本规格默认），还是只切换目标、由左键再打开？
3. 「默认发行版」是否需要在列表里单列（V1 是），还是只在没有其他发行版时出现？
