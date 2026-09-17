# easy-shell

一个「够用且克制」的 SSH + SFTP 客户端 —— 用来替代已停更的 WindTerm。

终端 + SFTP + 会话管理，别的不做。视觉规范取自 Linear，代码完全自有，可长期维护。

- 技术栈：**Tauri 2 + React 19 + TypeScript + Vite**（前端）/ **Rust**（内核）
- SSH 引擎是 **`russh` 纯 Rust 直连**，不依赖系统 `ssh.exe`；终端仿真交给 **xterm.js**，Rust 只搬字节流
- 目标平台 **Windows 优先**，代码保持跨平台（macOS / Linux 尚未适配）
- 里程碑 M0–M9 已完成，见 `PLAN.md` 的进度表

## 开发

需要 Node、Rust 工具链，以及 **Visual Studio 2022**（MSVC 链接器）。

```bash
npm install

npm run tauri dev     # 桌面端开发（先起 vite 再开 webview）
npm run dev:web       # 浏览器预览：Tauri IPC 换成假数据，能在普通浏览器里看界面
```

`dev:web` 是为了让 UI 层（布局、主题、交互）能被自动化工具看到 —— Tauri 的原生 webview
够不着，没有这层假后端就只能靠人眼盯。

## 质量闸门

```bash
npm run typecheck         # 前端类型检查（没配 eslint/prettier，这就是唯一闸门）
npm run check:commands    # 后端命令注册 ↔ api.ts 包装 ↔ 预览 mock 三方对齐
./tools/build.sh test     # Rust 测试（59 个单元 + 13 个集成，集成测试会起真服务端）
```

**Rust 编译必须走 `tools/build.sh`**：Git Bash 的 `/usr/bin/link.exe` 会顶替 MSVC 的 `link.exe`，
且 MSVC 需要 `LIB` 指向 SDK 的 `um/ucrt`。脚本顶部硬编码了 VS 2022 的路径，VS 版本不同要改那四个变量。

## 打包

```bash
./tools/package.sh        # 前端构建 + Rust release + msi/nsis，约 3–5 分钟
```

产物在 `src-tauri/target/release/`（exe）与 `bundle/{msi,nsis}/`（安装包）。

**改完代码要打包**：用户是靠装出来的 exe 验收的，前端改动不打包就还是旧行为，会伪装成
「改了没生效」。但打包成功不等于功能验证过 —— 拖拽、连接、认证这类交互自动化测不了，
需要手动试，交付时要说明哪些没验。

## 架构

```
React 前端  ──Tauri IPC(invoke + Channel)──  Rust 核心  ──russh / russh-sftp / portable-pty──  远端
```

三条铁律（详见 `PLAN.md`）：

1. **一条 SSH 连接复用**终端 / SFTP / 端口转发，不为每个功能单独建连。
2. **前端不持有连接状态**，连接、凭据、通道全在 Rust 侧 state 管理器，前端只有 id + 事件流。
3. **所有长耗时操作走 Tauri `Channel` 推事件**，不用轮询。

## 文档

| 文件 | 内容 |
| --- | --- |
| `PLAN.md` | 产品决策、里程碑与进度、风险与对策，**动架构前必读** |
| `TODO.md` | 已完成之外的功能缺口，按优先级排序（唯一待办清单） |
| `DESIGN.md` | Linear 设计系统落地（从 Linear 抽取的 token），**改 UI 前必读** |
| `AGENTS.md` | 给 AI 助手的工作指引：命令、模块职责、高危坑位 |
| `CODEBUDDY.md` | 同上但更详细的历史坑位清单 |
