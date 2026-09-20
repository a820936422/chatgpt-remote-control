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

## 没有新工具

全部开启时为 53 个工具。只启用基础工具为 26 个；基础加浏览器为 51 个；基础加桌面为 28 个。

修改 `config.json` 后先重启用户服务，再到 ChatGPT 插件详情刷新/重新扫描工具并保存，新建聊天重新选择插件。账号或插件的工具开关也会影响可用性。

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
