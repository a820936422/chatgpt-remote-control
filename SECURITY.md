# 权限与数据 / Security

本项目把本机能力提供给你在 ChatGPT 中选择的插件。请按实际权限理解这条连接：

- Desktop Commander 的 Shell 和进程工具以当前系统用户身份执行。`allowedDirectories` 不限制 Shell；命令屏蔽列表也不是系统沙箱。浏览器中的任意代码工具可能执行服务进程权限下的代码。
- 本项目配置的 workspace 用于路径解析和 Playwright 文件操作范围，不能隔离同一用户的文件、Shell 或其他 MCP 工具。
- 文件内容、网页内容和截图在工具调用时会通过 Tunnel 传给远端客户端。浏览器配置中的登录状态位于本机，浏览器仍可访问对应账号内容。
- 浏览器使用独立持久配置，不复制日常浏览器 Cookie。Chrome 的进程沙箱保持启用；这不等于对整个连接器的权限隔离。
- 截图临时目录权限为私有，完成或失败后清理。浏览器下载、网页截图和其他显式输出保留在配置的输出目录。
- Work 调度默认关闭。启用后，主聊天可读取允许范围内的本地 Work 聊天信息及任务结果，并提交新指令、中断或压缩目标上下文；这些内容会通过 Tunnel 返回远端客户端。它不提供云端 Work 的访问入口。

## 凭据和日志

`runtime.env` 位于用户配置目录，目录权限 `700`、文件权限 `600`。凭据配置只允许本机交互式终端，runtime key 使用隐藏输入，成功收集后原子替换文件。不要通过 CLI 参数传入 key。

Tunnel 进程需要 runtime key；桥接不会把 `CONTROL_PLANE_API_KEY` 传给下游 MCP、截图和显示器信息进程。**这不是同用户访问隔离**：Shell 工具若获得相应指令，仍具有该用户读取本地文件的权限。需要更强隔离时，应使用专门的低权限系统用户或独立机器。

桥接为每次 `tools/call` 记录 `start`、`attempt`、`retry`、`finish` 诊断事件，用随机 trace 关联进程 ID、工具名、路由、耗时、并发量和错误类别。安全 JSON 同时写入 stderr 和 `reliability.stateDirectory/diagnostics/bridge-PID.jsonl`；目录权限 `700`、日志权限 `600`，每个 PID 的文件到 5 MiB 时轮转并保留一份旧日志，轮转边界按 PID 计算。日志字段使用白名单，不记录参数、结果、文件路径、内容、异常消息、截图或密钥。第三方组件仍有自己的日志和使用统计行为；共享 Desktop Commander 配置位于它的默认用户目录。本项目不重写该配置。

仓库只发布源代码、锁文件、测试与无秘密示例。不提交 `.env`、`runtime.env`、浏览器配置目录、Cookie、下载文件、真实日志或屏幕图像。

## 重试和文件写入回执

自动重试仅适用于固定明确只读名单中的临时故障，最多 3 次总尝试，并尊重 `Retry-After` 和 `structuredContent.retry_after_ms`；要求等待超过配置上限时停止当前调用的重试。取消、权限和文件不存在等错误不重试。浏览器工具、`work_wait` 和所有修改操作不自动重试。请求未到本机时可能没有 trace；不能把云端超时当作本机操作没有执行的证据。

`write_file` 可使用 `request_id` 在 `reliability.stateDirectory` 保存持久意图和完成回执，按 ID 使用 Linux `flock` 的内核锁。意图在执行前同步落盘；相同 ID 与参数的已完成请求返回缓存回执，不重复追加，结果未知时阻止再次执行。回执持久记录保留输入哈希、状态和固定确认文本，省略原参数、文件内容及上游原回复/错误；重复调用返回回执而非原回复内容。记录属于私有运行数据，升级和卸载保留；删除记录或自动改用新 ID 会失去原请求的去重保护。省略 ID 的兼容调用没有回执去重。

## Work 会话和任务记录

Work 桥接连接与服务用户同属的桌面 IPC 套接字，不额外监听网络端口。该内部接口有桌面版本耦合；不要将 IPC 套接字暴露给其他用户或网络。聊天内容、任务提示、结果及插件路径都可能含隐私，公开诊断时只提供脱敏错误和必要版本信息。

任务变更依赖 Linux `flock` 的内核文件锁，同一状态目录的桥接实例共用锁；进程崩溃后内核释放锁。幂等记录独立持久保留，连接断开或进程退出不意味着可以用新请求 ID 重复派发。

`work.stateDirectory` 用于保存任务记录，保持私有目录权限。它属于运行数据，升级和卸载均保留；不要提交到 Git 或发送到公开 Issue。对请求结果不确定的派发，应查询原任务记录并重用原任务 ID，不应另建任务重复执行。

显式指定技能和插件会把它们加入 Work 任务输入，但不会绕过桌面应用已有的启用状态、权限或审批。会话 allowlist 只限制本项目 Work 工具，不能限制同用户 Shell 工具或其他本机接口。

## 暂停与撤销

```bash
systemctl --user stop chatgpt-remote-control.service
systemctl --user disable chatgpt-remote-control.service
```

在 ChatGPT 禁用或删除插件可停止其使用入口；如凭据泄露，应在 OpenAI 组织中撤销/轮换相应 runtime key。删除网页插件不等于撤销本机保存的 key。

## 问题报告

不要在公开 Issue、PR、测试日志中粘贴 key、完整环境变量、Cookie、浏览器 profile、真实截图或含隐私的工具返回。连接问题可提供操作系统/桌面版本、固定依赖版本、脱敏错误码和最小复现步骤。

若 GitHub 仓库提供 Private vulnerability reporting，请优先使用私密漏洞报告；否则先通过不含漏洞利用细节或秘密的 Issue 请求维护者提供私密沟通渠道。

## 依赖安全覆盖

公开版本使用 `sharp@0.35.4`，并覆盖 Desktop Commander 原先声明的旧版本范围，处理 [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) 与 [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)。ExcelJS 的 uuid 固定覆盖为 `11.1.1`，处理 [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)。覆盖由 package.json 和锁文件记录，测试包含图片管道及带条件格式的 Excel 读写。

`npm audit --omit=dev` 的结果随公告数据库变化；零已知公告不代表没有漏洞。升级应同时考虑兼容性和上游安全修复。
