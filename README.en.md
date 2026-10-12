# ChatGPT Remote Control

Control your own Linux computer from ChatGPT through **OpenAI Secure MCP Tunnel → a local MCP bridge → Desktop Commander, Playwright and KDE desktop tools**.

[中文文档](README.md) · [Security and data access](SECURITY.md) · [Configuration](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md) · [Validation record](docs/validation.md)

This community project packages a deployment validated on CachyOS / KDE Wayland. It is not an official OpenAI remote desktop product.

## Capabilities

- Read, write, edit and search local files; execute commands and manage processes through Desktop Commander.
- Navigate websites, read accessibility snapshots, click, type, fill forms, manage tabs, and upload/download files through Playwright MCP.
- Run a dedicated visible Chrome/Chromium with a persistent login profile.
- Capture the KDE desktop or active window and inspect monitor layout.
- Optionally delegate to existing local Work conversations, retrieve results, wait, interrupt and compact their context through the running desktop app.

Work orchestration is disabled by default. With file, browser and desktop features enabled, the pinned versions expose **53 tools**: 26 Desktop Commander, 25 browser and 2 desktop tools. Enabling Work adds 9, for **62 tools** in total.

**Limitations:** whole-desktop mouse/keyboard control is not implemented. Screenshot capture and valid MCP image delivery do not guarantee that ChatGPT Code Mode can use the image as visual input. Browser automation uses page structure and works without screenshot vision.

## Requirements

Linux x86_64, systemd user services, Python 3.10+, Node.js 22+ and npm. Browser automation requires an installed Chrome/Chromium and a graphical login. Screenshots require KDE Spectacle and `kscreen-doctor`; use `--no-desktop` on other desktops.

Work orchestration and keyed write receipts require Linux `flock` (normally provided by util-linux) for kernel-backed locking across bridge instances. Work additionally requires a compatible running desktop app.

Your ChatGPT account/workspace must offer developer plugins with the **Tunnel** connection option. Create a Tunnel in the relevant OpenAI organization and obtain a runtime key with the required **Tunnels Read + Use** permissions. See the [official Secure MCP Tunnels guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Use a distinct Tunnel ID for every simultaneously running computer. A suitably authorized key can be reused, but two active stdio clients must not share one Tunnel ID.

## Install

Run as your normal desktop user, not root:

```bash
git clone https://github.com/a820936422/chatgpt-remote-control.git
cd chatgpt-remote-control
python3 scripts/deploy.py install
python3 scripts/deploy.py configure
```

The installer copies the application into the user data directory, installs locked npm dependencies, verifies official Tunnel `0.0.16` against its pinned SHA-256, and creates a user service. Installation does not start the connection, collect credentials or automatically select a newer release.

`configure` prompts locally for a Tunnel ID and a hidden runtime key, atomically stores them in a mode-600 file inside a private directory, then enables and starts the service. Never put a real key in a command argument, issue, chat or repository.

Options:

```bash
python3 scripts/deploy.py install --browser /usr/bin/chromium --node /usr/bin/node
python3 scripts/deploy.py install --proxy http://127.0.0.1:7897
python3 scripts/deploy.py install --no-desktop
python3 scripts/deploy.py install --no-desktop --no-browser
python3 scripts/deploy.py install --enable-work  # newly generated configuration only
```

The proxy above is an example, not a default. The default health endpoint is bound to `127.0.0.1:18081`; change it with `--health-port`. No public inbound MCP port is required.

## Connect ChatGPT

At <https://chatgpt.com/plugins>, create a plugin such as `desktop-connector`. Select **Tunnel**, select this computer's Tunnel, and use **None / No Authentication** for MCP authentication. The Tunnel itself still authenticates with the runtime key. Scan/save the tools, enable the tools you need, and start a new conversation with the plugin selected.

After changing tools, refresh/rescan the plugin and start a new conversation. Restarting the local service does not guarantee the web client refreshes its cached definitions.

Try:

> Use desktop-connector's browser_navigate to open https://example.com/ on my computer. Read the page using browser_snapshot, click Learn more using its snapshot reference, and report the resulting URL and title. Actually call the browser tools, then close the automation browser with browser_close.

The first browser action opens a separate visible window. Log into websites manually in that window when needed. Persistent cookies and local storage survive browser closure; sites can still expire login sessions. This browser does not attach to your everyday ChatGPT tab.

Default downloads and automatic artifacts are stored in `~/Downloads/ChatGPTBrowser/`. Named relative outputs are resolved against the configured workspace. Prefer explicit absolute file paths.

## Delegate to local Work conversations

Run the desktop app on the target computer and open a dedicated local Work conversation. Enable `work.enabled`, restart this connector service, then refresh the ChatGPT plugin tools. `install --enable-work` enables it only in newly generated configuration; an upgrade preserves existing files. See [configuration](docs/configuration.md#本地-work-调度).

| Tool | Purpose |
| --- | --- |
| `work_info` | Inspect connectivity, configuration and interface limitations |
| `work_list_chats` | List permitted local conversation metadata |
| `work_list_skills` | Discover local skill names and exact paths |
| `work_send` | Dispatch or continue a task in an idle conversation, optionally selecting model, reasoning effort, skills and plugins |
| `work_status` / `work_result` | Inspect status or retrieve results by task ID |
| `work_wait` | Wait 5 seconds by default, capped at 10 seconds; 0 reads cached status |
| `work_interrupt` | Interrupt a dispatched task by its confirmed execution turn |
| `work_compact` | Request real context compaction and track completion |

Start with `work_info` and `work_list_chats`. Send `work_send` with `thread_id`, `prompt` and a required unique `request_id`; retain the returned `task_id` for status, wait and result calls. An accepted request does not mean execution has completed. A busy target rejects dispatch: wait for completion or explicitly interrupt before sending another task.

The main Chat can choose `model` and `reasoning_effort` for the task's complexity, for example `model: "gpt-6.1-sol"` and `reasoning_effort: "medium"`. Omitting them inherits the target's current settings. Explicit selections continue into subsequent Work turns; explicitly select different values when you want to change them again. The target's workspace, permissions, collaboration mode and developer instructions are preserved.

Status and result calls return `requested_model` and `requested_reasoning_effort`, plus `effective_model` and `effective_reasoning_effort` from the actual execution turn; effective effort is `null` when that turn provides no reasoning parameter, rather than copied from the request. Effective model reflects the turn's last reroute target when present: the bridge does not substitute models, but the desktop or service may reroute, so check optional `model_reroute: {from_model, to_model, reason}`. The desktop server validates availability; this bridge has no live model catalog, and accepted dispatch does not establish completion.

Optional `skills: [{name, path}]` and `plugins: [{name, path}]` are passed as structured Work input. Use `work_list_skills` for absolute `SKILL.md` paths. Plugin paths must be exact `plugin://ID@SOURCE` or `app://ID` references, enabled in that target conversation. Selection does not install components or change permissions.

Retries with the same `request_id` and identical input reuse the recorded task. Changing the prompt, model, reasoning effort or component selections requires a new ID. After an IPC timeout, reuse that ID or query the original task; creating another request can duplicate work. `work_compact` also requires `thread_id` and `request_id` and returns a task to track. Only a completed compaction event confirms success; sending `/compact` as text is not equivalent.

`work_wait` returns `effective_timeout_ms` and `retry_after_ms`; follow that interval when polling the same task. Older `timeout_ms` values up to 45000 are accepted but clamped to 10 seconds. A value of 0 reads cached status without refreshing desktop IPC. For ordinary file and command work on the same computer, let Work use its native local tools to reduce Tunnel round trips.

The adapter uses the desktop app's internal IPC at `~/.codex/ipc/ipc.sock` by default. This is version-dependent and requires actual validation after desktop updates. It does not require a desktop restart or `app-server proxy`, create conversations, or access cloud Work. Existing local conversations must be loadable in the running desktop app; open the target there before dispatch.

The live MCP check passed dispatch, idempotent retries, follow-up, actual plugin/skill use, interruption and real compaction on Linux with desktop CLI `0.162.0-alpha.17.2`. See [the validation record](docs/validation.md#本地-work-调度验收2026-10-12) for scope and evidence.

## Timeouts and duplicate requests

Each `tools/call` emits `start`, `attempt`, `retry` and `finish` diagnostics with a random trace, process ID, tool/route, elapsed time, concurrency and error class. Arguments, file paths, content, exception messages and keys are omitted. The same safe JSON goes to stderr and `reliability.stateDirectory/diagnostics/bridge-PID.jsonl`, independently of Tunnel stderr forwarding. The directory is mode 700 and logs are mode 600; each PID's log rotates at 5 MiB with one previous file retained.

Transient failures on a fixed read-only allowlist get at most 3 attempts, with exponential backoff starting at 250 ms and capped at 2000 ms by default. Server `Retry-After` and `structuredContent.retry_after_ms` are respected; a requested delay above the cap stops that call instead of retrying early or waiting indefinitely. Cancellation, permission and missing-file errors are not retried. Browser tools, `work_wait` and all mutations are never automatically retried.

An optional unique `request_id` on `write_file` adds a durable `write_receipt: {receipt_id, request_id, status, duplicate}`. Retrying the same key and arguments after completion returns the cached receipt with `duplicate: true` without appending again; changed arguments with that key are rejected. Intent is synced before execution, and an uncertain transport outcome blocks re-execution with that key. Read back the file before deciding what to do next; do not automatically resend with a new key. Without a key, existing behavior remains available without receipt deduplication.

If a request times out before reaching the bridge, there may be no local trace. Local retries cannot repair cloud-side connectivity, and upgrading to the pinned Tunnel `0.0.16` alone does not establish that the network problem is fixed. See [diagnostic guidance](docs/troubleshooting.md#网络超时与调用诊断).

## Manage and test

```bash
python3 scripts/deploy.py status
systemctl --user stop chatgpt-remote-control.service
systemctl --user start chatgpt-remote-control.service
python3 scripts/deploy.py uninstall
```

Uninstall removes the service and preserves files, credentials and browser data. The project does not enable linger or change sleep settings. Desktop features require a logged-in graphical session.

```bash
npm ci --ignore-scripts
npm test
npm run test:python
npm run test:integration
npm run test:desktop  # requires a logged-in KDE desktop and Chrome/Chromium
```

Integration checks create temporary HOME/config/profile directories and do not need Tunnel credentials. CI covers unit tests and MCP discovery/file operations. Desktop tests capture the screen locally and exercise a local browser fixture without uploading screenshot artifacts.

`scripts/verify-work.mjs` is a separate, opt-in live check. It requires `--thread-id` for an existing dedicated local Work chat opened in the desktop app. `--config` selects connector configuration and `--out` stores a private report. Optional paired `--plugin-name`/`--plugin-path` and `--skill-name`/`--skill-path` test actual component use; `--interrupt` and `--compact` additionally exercise interruption and real compaction. It sends actual tasks and never creates a chat. See [the live-check example](docs/troubleshooting.md#work-实机验收).

## Versions and licensing

Pinned dependencies: tunnel-client 0.0.16, Desktop Commander 0.2.51, Playwright MCP 0.0.82, MCP SDK 1.30.0, sharp 0.35.4. The lockfile also overrides Desktop Commander's sharp and ExcelJS's uuid (11.1.1) to patched versions; image and spreadsheet compatibility are tested. Revalidate discovery and browser behavior when upgrading dependencies.

The bridge preserves Desktop Commander's resource, prompt and logging interfaces: forwarding only tools can break ChatGPT plugin creation when tools refer to UI resources.

Commands run with the current user's OS permissions. Directory settings and command blocklists are not a system sandbox. Read [SECURITY.md](SECURITY.md) before connecting a machine with sensitive data.

Original project code is [MIT licensed](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
