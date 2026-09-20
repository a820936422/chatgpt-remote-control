# 权限与数据 / Security

本项目把本机能力提供给你在 ChatGPT 中选择的插件。请按实际权限理解这条连接：

- Desktop Commander 的 Shell 和进程工具以当前系统用户身份执行。`allowedDirectories` 不限制 Shell；命令屏蔽列表也不是系统沙箱。浏览器中的任意代码工具可能执行服务进程权限下的代码。
- 本项目配置的 workspace 用于路径解析和 Playwright 文件操作范围，不能隔离同一用户的文件、Shell 或其他 MCP 工具。
- 文件内容、网页内容和截图在工具调用时会通过 Tunnel 传给远端客户端。浏览器配置中的登录状态位于本机，浏览器仍可访问对应账号内容。
- 浏览器使用独立持久配置，不复制日常浏览器 Cookie。Chrome 的进程沙箱保持启用；这不等于对整个连接器的权限隔离。
- 截图临时目录权限为私有，完成或失败后清理。浏览器下载、网页截图和其他显式输出保留在配置的输出目录。

## 凭据和日志

`runtime.env` 位于用户配置目录，目录权限 `700`、文件权限 `600`。凭据配置只允许本机交互式终端，runtime key 使用隐藏输入，成功收集后原子替换文件。不要通过 CLI 参数传入 key。

Tunnel 进程需要 runtime key；桥接不会把 `CONTROL_PLANE_API_KEY` 传给下游 MCP、截图和显示器信息进程。**这不是同用户访问隔离**：Shell 工具若获得相应指令，仍具有该用户读取本地文件的权限。需要更强隔离时，应使用专门的低权限系统用户或独立机器。

桥接的诊断日志只记录发现接口、成功与否、错误码及耗时，不记录工具参数、网页内容或截图。第三方组件仍有自己的日志和使用统计行为；共享 Desktop Commander 配置位于它的默认用户目录。本项目不重写该配置。

仓库只发布源代码、锁文件、测试与无秘密示例。不提交 `.env`、`runtime.env`、浏览器配置目录、Cookie、下载文件、真实日志或屏幕图像。

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
