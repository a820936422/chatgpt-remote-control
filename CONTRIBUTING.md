# Contributing

Please keep changes reproducible and validate the full MCP contract, not just the Tunnel health endpoints.

```bash
npm ci --ignore-scripts
npm test
npm run test:python
npm run test:integration
```

For changes involving screenshots, browser behavior or process lifetime, also run `npm run test:desktop` in a logged-in KDE session with Chrome/Chromium. Tests use disposable profiles. Do not substitute a production browser profile or publish screenshots from your desktop.

When upgrading dependencies:

1. Change the exact version and regenerate `package-lock.json`.
2. Check upstream capabilities, all tool pages, duplicate names and UI resource references.
3. Preserve resources, prompts, logging, cancellation and progress forwarding.
4. Verify file write/read, browser interaction, download placement and persistent profile behavior.
5. Test a newly scanned ChatGPT plugin and state which client behavior you actually observed.

A local MCP image result does not prove that the ChatGPT model received image input. Keep that distinction in documentation and issue reports.

Installer changes must preserve existing credentials and user configuration, handle paths containing spaces, and keep download checksum verification. Never add credentials, real runtime environment files, personal logs, browser cookies or profiles to tests or examples.

The project targets Linux x86_64 with systemd user services. Contributions for other platforms should explicitly separate tested support from unverified portability and include the matching installation path.
