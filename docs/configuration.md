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
| Work 任务状态 | `~/.local/state/chatgpt-remote-control/work/` |
| 本地桌面 IPC | `~/.codex/ipc/ipc.sock` |
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
- `work.enabled`：是否注册本地 Work 调度工具，默认 `false`。

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

## 本地 Work 调度

此功能把 ChatGPT 中的主聊天连接到已经运行的桌面应用，再向本地 Work 聊天提交任务。它使用桌面内部 IPC，默认套接字为 `~/.codex/ipc/ipc.sock`；不启动第二个 app-server，也不要求重启桌面应用。`app-server proxy` 所需的控制套接字和此 IPC 不是同一个接口。

桌面应用内部协议会随版本变化，必须用目标机器上的实际版本验收。云端 Work 聊天不在此功能范围内。本地目标需要在桌面应用中可加载；派发前先打开目标聊天，让应用发现它的会话 owner。会话可用的插件、技能和账户权限由桌面应用决定。

Work 调度还需要 Linux `flock`（util-linux）。任务派发通过内核文件锁协调同一状态目录下的多个桥接实例；锁随进程退出释放，不通过删除锁文件强行解锁。标准 Linux 安装通常已包含该程序。

首次安装可使用 `install --enable-work` 生成启用配置。升级时已有 `config.json` 原样保留，`--enable-work` 不覆盖它；请在现有配置中添加或修改 `work`，然后只重启本项目服务并在 ChatGPT 刷新工具列表。`--force-config` 会重建其他配置，因此不应仅为启用 Work 而使用它。

```json
{
  "work": {
    "enabled": true,
    "codexHome": "/home/YOUR_USER/.codex",
    "socketPath": "/home/YOUR_USER/.codex/ipc/ipc.sock",
    "stateDirectory": "/home/YOUR_USER/.local/state/chatgpt-remote-control/work",
    "allowedThreadIds": [],
    "allowCodexThreads": false,
    "requestTimeoutMs": 10000
  }
}
```

上述片段需合并到主配置并替换占位符。`codexHome` 指向运行中的桌面应用数据目录；`socketPath` 指向其 IPC 套接字；`stateDirectory` 保存本项目任务记录，不应放进公开仓库。`requestTimeoutMs` 是单次 IPC 请求的超时，允许 1000 到 30000，默认 10000；与 Work 执行整个任务所需时间不同。

`codexHome` 默认为用户 HOME 下的 `.codex`；`socketPath` 默认在其 `ipc/ipc.sock`；`stateDirectory` 默认使用 XDG 状态目录下的 `chatgpt-remote-control/work`。这些字段的相对路径基于主配置所在目录，不自动展开 JSON 中的 `~` 或 `$HOME`。

`allowedThreadIds` 为空时允许所有匹配的本地 Work 聊天，设为非空数组则仅允许其中 ID。默认 `allowCodexThreads: false`，只允许本地 Work 来源；设为 `true` 可额外允许本地 Codex 聊天。两个条件共同限制发现和任务操作，不能用它访问云端聊天。建议专用测试/工作聊天配合非空 allowlist。

`work_send` 和 `work_compact` 都要求唯一 `request_id`。相同内容重试会复用已保存的任务记录；更改内容必须使用新 ID。派发不确定时不能自动重新执行。目标繁忙时先等待或显式中断，再发新任务。`work_wait.timeout_ms` 允许 0 到 45000，默认 30000；0 返回即时状态。

压缩操作通过专用 IPC 请求触发；向聊天发送 `/compact` 文本不等价于调用压缩接口。插件和技能可显式附在任务输入中，但名称和路径必须来自目标会话实际可用的组件。技能要求绝对 `SKILL.md` 文件路径，插件要求 `plugin://ID@SOURCE` 或 `app://ID` 引用；不会安装或启用缺失组件，目标模型、工作目录和权限仍从原聊天继承。

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
