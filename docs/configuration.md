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
| 文件写入回执 | `~/.local/state/chatgpt-remote-control/reliability/` |
| 本机调用诊断 | `~/.local/state/chatgpt-remote-control/reliability/diagnostics/bridge-PID.jsonl` |
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
- `reliability`：明确只读调用的重试上限、退避和带 ID 写入的回执目录，见下节。

`workspace`、`browser.configFile` 的相对路径基于主配置所在目录解析。JSON 中不会自动展开 `~` 或 `$HOME`；安装程序生成绝对路径。

入口 `src/bridge.mjs` 通过 `CRC_CONFIG` 读取配置；未设置时读取 XDG 默认位置。

```bash
CRC_CONFIG=/absolute/path/config.json node src/bridge.mjs
```

这是 MCP stdio 入口，stdout 用于协议，直接启动后等待输入是正常的。日志只走 stderr。

## 调用稳定性与写入回执

```json
{
  "reliability": {
    "readRetryAttempts": 3,
    "readRetryBaseMs": 250,
    "readRetryMaxMs": 2000,
    "stateDirectory": "/home/YOUR_USER/.local/state/chatgpt-remote-control/reliability"
  }
}
```

`readRetryAttempts` 是总尝试次数（含首次），最多 3 次，默认 3；设为 1 可关闭自动重试。仅固定只读名单中的临时故障适用。退避从 `readRetryBaseMs` 开始按指数增加，以 `readRetryMaxMs` 为上限，默认分别是 250 和 2000 毫秒；配置要求上限不小于初始退避。取消、权限、`ENOENT` 等错误不重试；`browser_*`、`work_wait` 和全部修改操作不自动重试。工具只读提示不会自行将工具加入这份固定名单。

当前名单为 `read_file`（仅本地文件，`isUrl` 未指定或为 `false`）、`get_file_info`、`list_directory`、`get_config`、`desktop_info`、`work_info`、`work_list_chats`、`work_list_skills`、`work_status`、`work_result`。名单中的未知错误也不重试，只有可明确分类的暂时传输/服务故障才适用。

服务器提供的 `Retry-After` 或 `structuredContent.retry_after_ms` 会约束重试等待；要求等待超过 `readRetryMaxMs` 时，本次调用停止重试并返回错误，既不提前重试，也不延长到超出配置的等待时间。

`stateDirectory` 默认使用 XDG 状态目录下的 `chatgpt-remote-control/reliability`，相对路径基于主配置目录。它保存 `write_file` 的持久意图和完成回执，保持私有权限，升级和卸载保留；带 ID 写入依赖 Linux `flock`（util-linux），按请求 ID 加锁协调多个桥接实例。不要把它放入仓库，也不要删除记录后期待旧请求 ID 仍能去重。

`write_file` 可附带唯一 `request_id`，例如：

```json
{
  "path": "/absolute/private/path/receipt-test.txt",
  "content": "写入验收\n",
  "mode": "append",
  "request_id": "write-example-unique-001"
}
```

写入意图先同步落盘，再交给上游工具执行，回执附在文本结果及 `_meta.write_receipt` 中，字段为 `{receipt_id, request_id, status, duplicate}`，状态为 `completed`、`failed` 或 `outcome_unknown`。首次调用保留上游原回复；同 ID、同参数再调用时返回缓存回执和固定确认文本，标记 `duplicate: true`，不再次执行或重放原回复内容，同 ID 改变参数则拒绝。传输结果未知时保留意图并阻止同 ID 再次执行，需先独立读回核实实际文件。回执持久记录只保留输入哈希、状态和固定回执文本，不保存文件参数、内容或上游原回复；省略 ID 保留上游接口，但没有回执去重保护，两种方式都不自动重试写入。

每个 `tools/call` 同时把安全 JSON 写入 stderr 和 `reliability.stateDirectory/diagnostics/bridge-PID.jsonl`，包括 `start`、`attempt`、`retry`、`finish` 事件、随机 trace、进程 ID、工具/路由、耗时、并发量和错误类别，不包含参数、路径、内容、异常消息或密钥。本机日志不依赖 Tunnel 的 stderr 转发；诊断目录权限 `700`、日志权限 `600`，每个 PID 的文件到 5 MiB 时轮转并保留一份旧日志，这个边界按 PID 计算。trace 标识本机调用；云端请求尚未到达桥接时，可能没有对应事件。

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

`work_send` 和 `work_compact` 都要求唯一 `request_id`。相同内容重试会复用已保存的任务记录；提示、模型、推理强度或组件选择变更后必须使用新 ID。派发不确定时不能自动重新执行。目标繁忙时先等待或显式中断，再发新任务。

`work_wait.timeout_ms` 默认 5000，有效上限 10000；兼容旧的 0 到 45000 输入，超过 10000 会截短。返回 `effective_timeout_ms` 和 `retry_after_ms`，主聊天按返回间隔查询同一任务。0 只读取缓存状态，不向桌面 IPC 刷新；任务仍在运行时，未完成状态不会变成完成。Work 在同一电脑上执行常规文件和命令任务时优先使用原生本机工具，减少 Tunnel 回环。

压缩操作通过专用 IPC 请求触发；向聊天发送 `/compact` 文本不等价于调用压缩接口。插件和技能可显式附在任务输入中，但名称和路径必须来自目标会话实际可用的组件。技能要求绝对 `SKILL.md` 文件路径，插件要求 `plugin://ID@SOURCE` 或 `app://ID` 引用；不会安装或启用缺失组件，也不改变目标权限。

### 每次派发的模型和推理强度

`work_send` 可选 `model` 和 `reasoning_effort`，由主聊天按任务复杂度选择；省略的设置继承目标 Work 聊天当前值。这些参数属于工具调用，不写在 `work` 配置中。例如：

```json
{
  "thread_id": "YOUR_LOCAL_WORK_THREAD_UUID",
  "request_id": "example-model-selection-001",
  "prompt": "分析这项任务的实现方案并报告结论。",
  "model": "gpt-6.1-sol",
  "reasoning_effort": "medium"
}
```

替换聊天 ID 后提交。显式模型和推理强度会延续到后续 Work 回合；它们不是仅这次调用生效的临时设置。后续需要其他设置时再次明确指定。工作目录、权限、协作模式和已有开发者指令仍保留。

`work_status`、`work_wait` 和 `work_result` 会报告请求值 `requested_model`、`requested_reasoning_effort`，以及实际回合元数据中的 `effective_model`、`effective_reasoning_effort`；缺少实际回合推理参数时，有效强度为 `null`，不从请求值推断。有效模型优先采用该回合最后的重路由目标，主聊天应同时核对可选的 `model_reroute: {from_model, to_model, reason}`。模型及推理强度由桌面服务器校验，本桥不提供实时模型目录或自动替换模型，但桌面/服务端可能重路由；尚未取得实际元数据时不能根据请求已接受推断生效。

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
