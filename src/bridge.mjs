#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema, SetLevelRequestSchema,
  ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema, LoggingMessageNotificationSchema,
  ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createDesktop } from './desktop.mjs';
import { allTools, indexTools, connectUpstream, withoutUiTemplate } from './upstream.mjs';

let server;
let commander;
let browser;
let stopping = false;
async function close(code) {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(code), 6000);
  timer.unref();
  await Promise.allSettled([server?.close(), commander?.client.close(), browser?.client.close()]);
  clearTimeout(timer);
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void close(0));

try {
  const config = await loadConfig();
  const desktop = createDesktop(config);
  commander = await connectUpstream('desktop-commander', [fileURLToPath(new URL('../node_modules/@wonderwhy-er/desktop-commander/dist/index.js', import.meta.url)), '--no-onboarding'], config);
  if (config.browser.enabled) browser = await connectUpstream('browser', [fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url)), '--config', config.browser.configFile], config, { browser: true });
  let routing;
  async function refreshTools(options = {}) {
    const [commanderTools, browserTools] = await Promise.all([
      allTools(commander.client, options), browser ? allTools(browser.client, options) : [],
    ]);
    if (browserTools.some(tool => !tool.name.startsWith('browser_'))) throw new Error('Unexpected browser tool namespace.');
    const next = indexTools([
      { owner: 'commander', tools: commanderTools },
      { owner: 'desktop', tools: desktop.tools },
      { owner: 'browser', tools: browserTools },
    ]);
    // Routine tool calls return data without automatically opening MCP App cards.
    if (!config.uiPreviews) next.tools = next.tools.map(withoutUiTemplate);
    routing = next;
    return next.tools;
  }
  await refreshTools({ timeout: 15000 });
  const capabilities = commander.capabilities;
  server = new Server({ name: 'chatgpt-remote-control', version: '0.1.0' }, {
    capabilities: { ...capabilities, tools: { ...capabilities.tools, listChanged: true } },
    instructions: [
      commander.client.getInstructions() ?? '',
      `This connector operates the user-owned computer ${config.label}. File and shell tools execute there with the current OS user's permissions. Workspace: ${config.workspace}.`,
      config.desktop.enabled ? 'desktop_screenshot captures the logged-in local KDE desktop, not a cloud browser. Receiving image bytes or dimensions does not prove visual understanding; only describe image contents if the client presents the image to you. desktop_info returns monitor layout.' : '',
      config.browser.enabled ? [
        'browser_* tools operate a dedicated visible browser on this computer, opened on first use. Its persistent profile is separate from the everyday browser. Log in manually in that window when needed.',
        'Use browser_navigate then browser_snapshot for readable page structure and element targets. Perform browser_click, browser_type and browser_fill_form using those targets, then inspect the updated page. This does not require screenshot vision.',
        'Omit filename on browser_take_screenshot to receive inline MCP image content plus a saved file. Specifying filename saves the image and returns only a file reference. Model image support still depends on the client.',
        'Use absolute paths for uploads and named outputs. Default browser output location is configured locally. browser_close closes this browser and preserves its profile. All browser calls share one state, so dependent operations must be sequential.',
      ].join('\n') : '',
    ].filter(Boolean).join('\n\n'),
  });

  const discovery = (schema, method, invoke) => server.setRequestHandler(schema, async (request, extra) => {
    const started = Date.now();
    try {
      const result = await invoke(request.params ?? {}, { timeout: 15000, signal: extra.signal });
      console.error(JSON.stringify({ component: 'bridge', method, ok: true, elapsed_ms: Date.now() - started }));
      return result;
    } catch (error) {
      console.error(JSON.stringify({ component: 'bridge', method, ok: false, code: error.code ?? null, elapsed_ms: Date.now() - started }));
      throw error;
    }
  });
  // Keep resources discoverable for cached descriptors and optional UI previews.
  // Omitting these interfaces previously broke ChatGPT app discovery.
  if (capabilities.resources) {
    discovery(ListResourcesRequestSchema, 'resources/list', (params, options) => commander.client.listResources(params, options));
    discovery(ListResourceTemplatesRequestSchema, 'resources/templates/list', (params, options) => commander.client.listResourceTemplates(params, options));
    discovery(ReadResourceRequestSchema, 'resources/read', (params, options) => commander.client.readResource(params, options));
    commander.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { void server.sendResourceListChanged().catch(() => {}); });
    commander.client.setNotificationHandler(ResourceUpdatedNotificationSchema, notice => { void server.sendResourceUpdated(notice.params).catch(() => {}); });
  }
  if (capabilities.prompts) {
    discovery(ListPromptsRequestSchema, 'prompts/list', (params, options) => commander.client.listPrompts(params, options));
    discovery(GetPromptRequestSchema, 'prompts/get', (params, options) => commander.client.getPrompt(params, options));
    commander.client.setNotificationHandler(PromptListChangedNotificationSchema, () => { void server.sendPromptListChanged().catch(() => {}); });
  }
  if (capabilities.logging) {
    server.setRequestHandler(SetLevelRequestSchema, (request, extra) => commander.client.setLoggingLevel(request.params.level, { timeout: 10000, signal: extra.signal }));
    commander.client.setNotificationHandler(LoggingMessageNotificationSchema, notice => { void server.sendLoggingMessage(notice.params).catch(() => {}); });
  }
  discovery(ListToolsRequestSchema, 'tools/list', async (_params, options) => ({ tools: await refreshTools(options) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const owner = routing.routes.get(name);
    if (!owner) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool: ' + name);
    if (owner === 'desktop') return desktop.call(name, args, extra.signal);
    const progressToken = request.params._meta?.progressToken;
    return (owner === 'browser' ? browser : commander).call(request.params, {
      timeout: 300000, signal: extra.signal,
      ...(progressToken !== undefined ? { onprogress: progress => {
        void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
      } } : {}),
    });
  });
  for (const peer of [commander, browser].filter(Boolean)) {
    peer.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void refreshTools({ timeout: 15000 }).then(() => server.sendToolListChanged()).catch(() => { console.error('Tool list refresh failed.'); });
    });
    peer.client.onclose = () => { if (!stopping) void close(1); };
    peer.client.onerror = () => { console.error('Upstream MCP transport reported an error.'); };
  }
  server.onclose = () => { if (!stopping) void close(0); };
  server.onerror = () => { console.error('Bridge transport reported an error.'); };
  await server.connect(new StdioServerTransport());
  console.error(`Remote control bridge ready: ${routing.tools.length} tools.`);
} catch (error) {
  // Do not serialize upstream exceptions: they can include environment or arguments.
  console.error(`Bridge startup failed (${error.name}). Check local configuration and installed dependencies.`);
  await close(1);
}
