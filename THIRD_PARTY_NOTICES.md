# Third-party notices

The original bridge, installer, tests and documentation in this repository are MIT licensed. Third-party components retain their own licenses. This repository does not vendor their source, browser profiles, or release binaries; the installer obtains dependencies from their publishers.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| OpenAI tunnel-client | 0.0.14 | Apache-2.0 | https://github.com/openai/tunnel-client |
| Desktop Commander | 0.2.51 | MIT | https://github.com/wonderwhy-er/DesktopCommanderMCP |
| Playwright MCP | 0.0.82 | Apache-2.0 | https://github.com/microsoft/playwright-mcp |
| MCP TypeScript SDK | 1.30.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| sharp | 0.35.4 | Apache-2.0 | https://github.com/lovell/sharp |
| uuid (ExcelJS override) | 11.1.1 | MIT | https://github.com/uuidjs/uuid |

Playwright MCP depends on Playwright and playwright-core; their exact versions are recorded in `package-lock.json`. sharp uses libvips and associated image libraries with their own licenses. Consult installed dependency license files before redistributing packaged copies.

Chrome/Chromium, KDE Spectacle and KScreen are external system prerequisites and are not distributed here. Their licenses and notices are provided by their respective vendors.

The pinned Tunnel archive is `tunnel-client-v0.0.14-linux-amd64.zip`, downloaded from the upstream `v0.0.14` release. Its SHA-256 is:

```text
15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3
```

This project is not affiliated with or endorsed by OpenAI, Microsoft, Google, or KDE. Product names identify the systems integrated by this project.
