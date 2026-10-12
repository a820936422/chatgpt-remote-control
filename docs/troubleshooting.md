# 排错与验收

按 **本机进程 → MCP 协议 → ChatGPT 工具发现 → 实际操作结果** 的顺序定位。健康端点成功并不能证明工具调用或视觉理解成功。

## 插件创建提示 Something went wrong

先运行：

```bash
python3 scripts/deploy.py status
systemctl --user is-active chatgpt-remote-control.service
```

本项目保留了原服务的 `resources/list`、`resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get` 和 `logging/setLevel`。Desktop Commander 部分工具引用 UI 资源，只有 tools 接口的简单代理可能在创建插件时失败，即使健康端点正常。

在项目目录执行 `npm run test:integration` 可验证完整发现和文件读写流程，不需要提供 key。若本机检查正常，检查 ChatGPT 所选 Tunnel、账号权限及插件工具缓存。重扫后用新聊天验证，不必反复重建 Tunnel。

## 服务无法连接

- 确认 Tunnel ID 属于当前组织，runtime key 对它有 Tunnels Read + Use 权限。
- 确认没有第二个活动客户端使用同一个 Tunnel ID。
- 需要代理时确认代理正在监听；安装网络能通并不代表 systemd 服务使用相同环境。
- 凭据输入取消或验证失败时保留旧值。新凭据写入后的连接失败会保留新值；可在本机交互式终端重新运行 `configure`。
- 查看 `journalctl --user -u chatgpt-remote-control.service`，对外分享前脱敏。不要使用 `systemctl show --property=Environment` 或打印 `runtime.env` 来收集诊断。

## 网络超时与调用诊断

先查看 `reliability.stateDirectory/diagnostics/bridge-PID.jsonl`，按发生时间与随机 trace 对照 `tools/call` 的 `start`、`attempt`、`retry`、`finish` 事件。默认目录为 `~/.local/state/chatgpt-remote-control/reliability/diagnostics/`；同样的安全 JSON 也写入 stderr，本机文件不依赖 Tunnel 转发。目录权限 `700`、日志权限 `600`，每个 PID 的文件到 5 MiB 时轮转并保留一份旧日志。事件只含进程、工具名、路由、耗时、并发量及错误类别，不含参数、路径、内容、异常消息或密钥。

有 `start` 但没有 `finish` 时，检查该进程是否仍在执行或被取消；有 `finish` 而主聊天仍报告网络错误时，按已返回的任务 ID 或写入回执恢复结果。没有对应日志时，请求可能尚未进入桥接，也可能落在其他实例/时段；本机只读重试不能修复这段云端连接。

固定只读名单中的临时故障最多 3 次总尝试，默认 250 毫秒指数退避，退避上限默认 2000 毫秒。服务器的 `Retry-After` 或 `structuredContent.retry_after_ms` 超过上限时，停止本次调用的重试，不提前发送，也不长时间挂起。取消、权限、`ENOENT` 等错误不重试。浏览器工具、`work_wait` 和修改操作不自动重试；不要因为网络错误就让主聊天无限重发。

对 `write_file` 使用唯一 `request_id`，保留它与原参数，并读取返回的 `write_receipt`。同 ID 重试收到完成回执与 `duplicate: true` 时不会再次追加；收到结果未知时先用独立读回核实文件，不自动换 ID 重写。带 ID 写入提示锁程序不可用时，检查 util-linux 的 `flock` 是否在服务 PATH。未传 ID 的旧调用没有回执去重，同样不能根据超时推断写入失败。Work 派发仍使用原 `request_id` 和 `task_id` 查询，避免另建任务。

安装器固定 Tunnel `0.0.16` 并校验官方 SHA-256，不自动下载最新版。升级是组件更新，云端/代理/本机哪层出现故障仍需按日志和实际结果定位，不能仅凭版本认定网络问题已解决。

## 没有新工具

默认 Work 关闭，文件、浏览器、桌面全部开启时为 53 个工具。只启用基础工具为 26 个；基础加浏览器为 51 个；基础加桌面为 28 个。开启 Work 再增加 9 个，全功能合计 62 个。

修改 `config.json` 后先重启用户服务，再到 ChatGPT 插件详情刷新/重新扫描工具并保存，新建聊天重新选择插件。账号或插件的工具开关也会影响可用性。

## Work 无法连接或找不到目标聊天

先调用 `work_info` 查看本地 IPC 是否可用。确认桌面应用以同一 OS 用户身份运行，`work.codexHome` 和 `work.socketPath` 指向当前应用的数据目录及 `ipc/ipc.sock`。不要尝试连接 `app-server proxy` 的控制套接字；此桥接使用的是另一个内部接口。

派发或查询提示无法取得任务锁时，确认系统已安装 util-linux 的 `flock`，且服务 PATH 能找到它。同一个 `stateDirectory` 下的实例会协调派发；不应删除锁文件来绕过正在运行的实例。

`work_list_chats` 只返回允许范围内的本地聊天元数据。检查 `allowedThreadIds`、`allowCodexThreads` 和目标来源；云端 Work 不支持。目标存在但没有可发现的 owner 时，先在桌面应用中打开该聊天，再重试。连接器不创建聊天，不会为找不到的目标启动第二个执行器。

桌面应用升级后出现方法不存在或消息格式错误，可能是内部 IPC 协议变化。保留脱敏错误、桌面版本和最小复现，重新运行专用本地聊天验收；健康端点成功不代表 Work 协议兼容。

## Work 已接受，但结果未返回

保存 `work_send` 返回的 `task_id`，使用 `work_status`、`work_wait` 和 `work_result` 跟踪同一任务。`work_wait` 默认等待 5 秒，有效上限 10 秒；旧的最高 45000 输入仍接受但截短。按返回的 `effective_timeout_ms` 和 `retry_after_ms` 继续查询，超时返回当前状态，不把未完成任务标成完成；0 只读缓存，不刷新桌面 IPC。结果应来自指定任务的真实完成事件，不能取另一轮旧回复来替代。

派发请求超时或连接断开时，任务可能已开始；用相同 `request_id` 和相同输入重试查回原记录，或查询已经取得的 `task_id`。不要换 ID 自动重派。连接恢复后仍无法确定完成情况时，先在桌面查看目标，再决定是否中断或继续。

繁忙目标拒绝新派发。等待当前任务结束后续派；需要停止时调用 `work_interrupt`。技能先用 `work_list_skills` 发现准确路径，插件必须在目标会话启用。选择结构化输入不等于保证任务一定调用了组件，验收时仍需检查实际工具/技能使用证据。

同一电脑上的普通 Work 文件和命令任务优先使用目标的原生本机工具；只在需要连接器特定能力或远端机器时走该插件，减少 Tunnel 回环与额外超时。

状态报告 `awaiting_approval` 或 `awaiting_user_input` 时，在桌面目标聊天处理相应请求，再查询同一任务。这些 Work 工具不代替目标应用的审批或用户输入界面。

## Work 模型或推理强度不符合预期

派发时可显式传 `model: "gpt-6.1-sol"`、`reasoning_effort: "medium"`；未传的值继承目标当前设置。明确选择会延续后续 Work 回合，要改回时需再次指定。

对比任务状态/结果的 `requested_model`、`requested_reasoning_effort` 与实际回合的 `effective_model`、`effective_reasoning_effort`；实际回合缺少推理参数时，有效强度为 `null`，不能把请求值当作实际值。有效模型反映该回合最后的重路由目标（如有），主聊天应检查可选的 `model_reroute: {from_model, to_model, reason}`；本桥不自动替换模型，但桌面/服务端可能重路由。还没有实际元数据时先查询同一任务，不把接受派发当作设置验证通过；服务器拒绝时报告原因，变更参数后使用新 `request_id`。

## Work 压缩未完成

使用 `work_compact` 并保存其返回的 `task_id`，再用状态/等待接口检查真实压缩事件。普通 `/compact` 文本不会触发该接口。已接受、正在压缩、IPC 超时和真实完成是不同状态；压缩中的目标应等其结束后再派任务。

## Work 实机验收

此脚本需要正在运行的兼容桌面应用、`flock` 和 `work.enabled: true` 的配置，不需要 Tunnel key。先在桌面创建并打开专用本地 Work 测试聊天，再通过 `work_list_chats` 获取其准确 ID。脚本不会新建聊天；未显式覆盖模型设置时继承目标当前值，并保留工作目录和权限，真实派发验证任务。

```bash
node scripts/verify-work.mjs \
  --thread-id YOUR_LOCAL_WORK_THREAD_UUID \
  --config /absolute/path/config.json \
  --out /absolute/private/path/work-verification.json
```

基础验收覆盖 9 个工具的发现、同用户 IPC、指定本地聊天和技能发现、任务派发、同 ID 幂等重试、等待与结果，以及向同一聊天续派。按需增加 `--interrupt`、`--compact`，以实际中断测试轮和压缩目标上下文。不要使用日常工作聊天来做这些验证。

指定插件/技能的实际使用验收可增加以下成对参数；将占位符替换为目标会话可用的准确值：

```text
--plugin-name YOUR_PLUGIN_NAME --plugin-path plugin://YOUR_PLUGIN_ID@YOUR_SOURCE
--skill-name YOUR_SKILL_NAME --skill-path /absolute/path/SKILL.md
```

当前该项验收任务面向带 `get_config` 的 desktop 连接器和用于核实官方文档的技能，不能用任意插件替代后仍期待同一测试通过。报告含所选聊天 ID 和任务结果摘要，保持私有，不直接上传到公开仓库。

## 浏览器无法打开

确认配置中的可执行文件存在，并在已登录图形桌面的终端中手工运行它。`browser.json` 的专用 profile 不应同时被另一个浏览器进程占用。

从当前图形会话只导入相关变量，然后重启：

```bash
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
systemctl --user restart chatgpt-remote-control.service
```

不要导入全部环境变量。显示服务器不匹配时，检查 `--ozone-platform=wayland` 是否适合当前会话。本项目保持 Chromium 沙箱开启；系统禁止所需用户命名空间时，请修复浏览器/系统配置，不要把关闭沙箱作为默认解决方法。

浏览器是专用独立窗口。日常 Chrome 已登录而自动化 Chrome 未登录属于预期行为。登录一次后，持久 Cookie 保留，但站点可能主动过期、撤销或要求多因素认证。

## 截图成功，但模型说看不到

确认返回有 `type: "image"`、`mimeType` 和有效图像，而不只是一个磁盘路径。

`desktop_screenshot` 始终返回标准 MCP 图像；`browser_take_screenshot` 只有在未传 `filename` 时附带内联图像。两者都不能保证网页 Code Mode 将图片作为视觉输入。

目前没有经过本项目验证的通用输出格式补丁可以消除此客户端限制。UI 组件显示给人、模型收到文本/base64、模型看到像素不能混为一谈。浏览器任务应优先使用 `browser_snapshot` 和语义操作。不要通过重新包装工具输出来规避客户端的安全拦截。

## 文件权限或路径问题

工具以启动服务的用户权限运行。浏览器上传用绝对路径，并确认文件位于 workspace 范围内。Playwright 显式相对输出基于 workspace，默认输出基于 `outputDir`。

Desktop Commander 的目录配置不约束 Shell。需要系统级隔离时，使用专用低权限用户；不要把一个空 `allowedDirectories` 列表当作禁止访问所有目录。

## 本机开发验收

```bash
npm test
npm run test:python
npm run test:integration
npm run test:desktop
```

最后一项会真实截取当前 KDE 桌面和活动窗口，并打开可见测试浏览器，调用本机 HTTP 测试页面完成中文填写、点击、上传下载、标签页及持久状态验证。测试图像只在本机进程内检查，不写到仓库或上传到 CI。截图和浏览器测试需要已登录图形会话；CI 只运行无桌面检查。

## 网页端验收应报告的证据

- 文件：实际工具名、唯一测试文件路径、写入内容及读回一致性。
- 浏览器：实际调用 `browser_*`，能够读取页面、点击后报告新网址和页面状态。
- 截图采集：图像 MIME、尺寸及有效图像返回。
- 视觉理解：必须能识别图中实际内容；只有尺寸/时间戳不算通过。

一个聊天的推测性回答或“我可以操作”不算实际验收。每次升级后至少做一次网页端文件和浏览器验证。
