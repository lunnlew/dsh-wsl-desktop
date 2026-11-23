# Plan: WSL 目标选择器 (V1)

Spec: `spec/SPEC-wsl-target-picker.md`

## 组件与依赖

1. **Host：发行版清单** `listDistros()`（`index.js`）
   - `spawnSync('wsl.exe', ['-l','-v'])` → UTF-16LE 解码 → `{ name, state, default }[]`
   - 回退 `-l -q`（老 WSL / 解析为空）→ `state: 'unknown'`
2. **Host：路由**
   - `GET /wsl-desktop/distros` → `{ ok, current, distros: [...+current] }`
   - `POST /wsl-desktop/select` → 校验（'' 或列表中名称）→ `configEditor.edit` 持久化 `distro` →
     `runHelper({...cfg, distro, autoLaunch: true})` → `{ ok, at }`
3. **Client：入口交互**（`client.js`）
   - 左键：维持现有 `openDesktop()`（用当前目标）
   - 右键 / ContextMenu / Shift+F10：打开列表（`preventDefault`）
   - 列表：标题 + 刷新 + 「默认发行版」+ 各发行版（状态、当前 ✓）；Esc/外部点击/再次右键关闭；
     ↑/↓ + Enter；`role="menu"` / `menuitemradio` / `aria-haspopup`
   - 选择：未运行 → POST /select → 进入 preparing → 复用现有状态机；运行中且目标不同 → 行内提示不切换；
     运行中且目标相同 → 关闭并聚焦已有窗口
4. **文档**：README / docs/DETAIL 的入口说明（左键/右键、目标）

## 实施顺序

1. Host `listDistros()` + `/distros`（可先用 `node -e` 和 curl 验证解析）
2. Host `/select`（持久化 + 触发）
3. Client 列表 UI + 键盘/右键交互
4. README/DETAIL、`scripts/ci.mjs` 通过、手工清单
5. 版本 0.4.0 → commit → tag/release（npm 发布）

## 风险与对策

- **wsl.exe 输出编码/老版本**：UTF-16LE 解码 + `-l -q` 回退；解析失败时路由返回 `ok:false` 且 UI 显示错误。
- **`position: fixed` 被祖先 transform 影响**：面板固定在按钮上方并在视口内夹取；打开时按按钮 rect 定位。
- **运行中切换**：客户端拦截并提示；路由仍可被直接调用（保守：路由只负责持久化+打开）。
- **配置编辑器不可用**（profile 无 editor）：返回 501，UI 显示错误。
- **无新增依赖 / 不需要重建副本**：`distro` 通过 `DSH_WSL_DISTRO` 传副本，无需 `PATCH_VERSION` 变更。

## 验证检查点

- `node scripts/ci.mjs`
- `wsl.exe -l -v` 解析（本机 3 个发行版）
- 左键不弹列表；右键弹列表；Esc/外部关闭；↑↓/Enter 工作
- 选 Debian（若安装）→ 配置持久化 → 状态机 preparing → 窗口运行
- 运行中选择其他目标 → 提示
