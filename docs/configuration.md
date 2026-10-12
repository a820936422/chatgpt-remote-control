# 配置说明

安装命令会生成适合当前用户的绝对路径；`examples/` 中的 `YOUR_USER` 是占位符，不应直接作为可运行配置复制。

## 默认位置

| 用途 | 默认路径 |
| --- | --- |
| 应用代码及 npm 依赖 | `~/.local/share/chatgpt-remote-control/app/` |
| 固定版本 Tunnel 可执行文件 | `~/.local/share/chatgpt-remote-control/bin/tunnel-client` |
| 主配置 | `~/.config/chatgpt-remote-control/config.json` |
| 浏览器配置 | `~/.config/chatgpt-remote-control/browser.json` |
| 安装与启动参数 | `~/.config/chatgpt-remote-control/deployment.json` |
| 本地凭据 | `~/.config/chatgpt-remote-control/runtime.env` |
| 专用浏览器资料 | `~/.local/share/chatgpt-remote-control/browser-profile/` |
| 默认下载/输出 | `~/Downloads/ChatGPTBrowser/` |
| 状态目录 | `~/.local/state/chatgpt-remote-control/` |
| systemd 用户服务 | `~/.config/systemd/user/chatgpt-remote-control.service` |

支持 XDG 配置、数据和状态目录。`install --home /absolute/path` 可为隔离测试指定一个替代用户目录；与 `--no-systemd` 配合使用，避免修改当前会话的服务。此选项不会创建操作系统用户或设置跨用户权限。

## 主配置

- `label`：工具说明使用的机器标识，默认系统主机名。
- `workspace`：文件路径和浏览器 workspace，默认用户 HOME。它不是 Shell 沙箱。
- `uiPreviews`：是否转发上游工具的 MCP App 预览模板，默认 `false`，常规调用只返回结果。设为 `true` 可恢复 Desktop Commander 的配置、文件等预览卡片；修改后重启服务并刷新客户端插件工具列表。
- `desktop.enabled`：控制是否注册 2 个 KDE 工具。
- `desktop.spectaclePath`、`desktop.kscreenDoctorPath`：截图和显示器程序，支持绝对路径或可在服务 PATH 中找到的程序名。
- `browser.enabled`：控制是否注册 Playwright 工具。
- `browser.configFile`：Playwright JSON 配置路径。

`workspace`、`browser.configFile` 的相对路径基于主配置所在目录解析。JSON 中不会自动展开 `~` 或 `$HOME`；安装程序生成绝对路径。

入口 `src/bridge.mjs` 通过 `CRC_CONFIG` 读取配置；未设置时读取 XDG 默认位置。

```bash
CRC_CONFIG=/absolute/path/config.json node src/bridge.mjs
```

这是 MCP stdio 入口，stdout 用于协议，直接启动后等待输入是正常的。日志只走 stderr。

## 浏览器

浏览器配置直接交给固定版本的 Playwright MCP。默认：可见 Chrome/Chromium、1280×800 网页视口、启用 Chromium 沙箱、专用持久 profile、允许下载。

安装在 Wayland 会话中时生成适用的启动参数。浏览器由 systemd 用户服务启动，依赖服务环境中的 `DISPLAY`、`WAYLAND_DISPLAY`、`XDG_RUNTIME_DIR` 和会话总线。若登录管理器没有正确导入，见排错文档。

默认不连接日常 Chrome，也不复制 Cookie。`browser_close` 保留 profile；删除 profile 才会清除其登录状态。不要将 profile 放进 Git 仓库。多个实例不能同时使用同一个持久 profile。

`outputDir` 控制自动命名的文件及下载保存位置。显式相对文件名仍相对于 workspace；自动化指令优先使用绝对路径。

本版本使用 Playwright 核心工具集，禁用页面动态注册的实验性 WebMCP 工具。核心集包含 `browser_run_code_unsafe` 等强权限工具；请参考 [权限说明](../SECURITY.md)。

## 代理和端口

`install --proxy http://127.0.0.1:7897` 是示例；没有传入代理时不预设本机端口。安装程序接受不含凭据的 HTTP/HTTPS 代理，将所选代理用于 npm、Tunnel 下载及生成的运行配置；浏览器绕过 localhost/回环地址。npm 自身的 registry、证书等设置仍适用。

Tunnel 代理以 `deployment.json` 的 `proxy` 为准；启动入口会据此覆盖或清除旧 `runtime.env` 中的代理。浏览器代理单独保存在 `browser.json`。修改后重启服务，不要在公开配置或命令行中保存含账号密码的代理 URL。

健康监听为 `127.0.0.1:<port>`，默认端口 18081。可以在第一次安装时指定 `--health-port 18082`。之后修改 `deployment.json` 的 `healthPort` 并重启服务即可；启动入口会覆盖旧运行环境中的端口。配置和状态检查要求 `/healthz`、`/readyz` 均返回 HTTP 200。

## 更新和回退

安装程序会保护已存在的用户配置；运行 `install --help` 查看显式覆盖配置的选项。常规升级先停止服务、保留配置、再安装并启动。备份应存放在仓库之外，且保持私有权限。

回退到之前的 Git 提交或 tag 后重新安装即可回退代码，但 npm 锁文件也必须属于同一版本。刷新 ChatGPT 插件工具列表，使网页缓存与本机服务一致。

卸载只停止并移除 systemd 服务。配置、key、profile、下载及程序文件留在本机；清除这些内容应由用户根据是否需要恢复登录资料另行决定。

## 已有部署迁移

本项目使用新的服务名和目录，不会自动接管其他 Desktop Commander/Tunnel 服务。迁移已有可用部署时，先停旧服务，再在本项目配置同一个 Tunnel；不要让两个客户端并行占用同一个 Tunnel ID。可在新部署验证成功后再停用旧服务的自动启动。

同一 OS 用户启动的 Desktop Commander 实例可能共用它的全局配置与使用统计。项目安装不会覆盖该配置，但真实工具调用可能更新上游使用统计。
