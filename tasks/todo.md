# Tasks: WSL 目标选择器 (V1)

- [x] Host: `listDistros()` 解析 `wsl.exe -l -v`（UTF-16LE）+ `-l -q` 回退
  - Acceptance: 返回 3 个发行版，含 default/state
  - Verify: `node -e` 打印；`node scripts/ci.mjs`
  - Files: `index.js`

- [x] Host: `GET /wsl-desktop/distros`
  - Acceptance: 200 + `{ ok, current, distros[] }`；`current` 来自配置
  - Verify: `curl http://127.0.0.1:<port>/wsl-desktop/distros`
  - Files: `index.js`

- [x] Host: `POST /wsl-desktop/select`
  - Acceptance: 校验名称；持久化 `distro`；触发 helper；返回 `{ ok, at }`；未知名称 400
  - Verify: curl POST + 观察 helper 状态文件
  - Files: `index.js`

- [x] Client: 右键/ContextMenu 打开目标列表（左键保持直接打开）
  - Acceptance: 左键不弹列表；右键弹列表且阻止默认菜单
  - Verify: 手工
  - Files: `client.js`

- [x] Client: 列表 UI（默认项、状态、当前 ✓、刷新、Esc/外部点击、↑↓/Enter）
  - Acceptance: 键盘可达；定位在按钮上方；窄栏相同
  - Verify: 手工
  - Files: `client.js`

- [x] Client: 选择行为（未运行 → POST /select + preparing；运行中不同目标 → 提示）
  - Acceptance: 切换后配置持久化、状态机进入 preparing；运行中不静默切换
  - Verify: 手工
  - Files: `client.js`

- [x] Docs: README / docs/DETAIL 入口说明
  - Acceptance: 描述左键/右键与目标列表
  - Verify: 阅读
  - Files: `README.md`, `docs/DETAIL.md`

- [x] Release 0.4.0
  - Acceptance: CI 通过；tag + release 触发 npm 发布
  - Verify: `npm view @karoy/dsh-wsl-desktop version`
