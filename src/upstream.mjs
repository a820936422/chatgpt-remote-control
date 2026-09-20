import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { childEnvironment } from './config.mjs';

export async function allTools(client, options = {}) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, options);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Upstream repeated a tools pagination cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

export function indexTools(groups) {
  const routes = new Map();
  const tools = [];
  for (const { owner, tools: entries } of groups) {
    for (const tool of entries) {
      if (routes.has(tool.name)) throw new Error('Duplicate tool name: ' + tool.name);
      routes.set(tool.name, owner);
      tools.push(tool);
    }
  }
  return { routes, tools };
}

export function serializeCalls(invoke) {
  let queue = Promise.resolve();
  return (params, options = {}) => {
    const result = queue.then(() => {
      options.signal?.throwIfAborted();
      return invoke(params, options);
    });
    queue = result.catch(() => {});
    return result;
  };
}

export async function connectUpstream(name, args, config, { browser = false } = {}) {
  const client = new Client({ name: `remote-control-${name}`, version: '0.1.0' }, browser ? { capabilities: { roots: { listChanged: false } } } : {});
  if (browser) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(config.workspace).href, name: 'Workspace' }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: config.workspace, env: childEnvironment(), stderr: 'pipe' });
  try {
    const connecting = client.connect(transport, { timeout: 20000 });
    // Drain stderr; URLs, page text, filenames and tool arguments stay out of our journal.
    transport.stderr?.on('data', () => {});
    await connecting;
    const capabilities = client.getServerCapabilities() ?? {};
    if (browser && Object.keys(capabilities).some(key => key !== 'tools')) throw new Error('Browser capabilities changed; review forwarding before upgrading.');
    const call = (params, options) => client.callTool(params, undefined, options);
    return { client, capabilities, call: browser ? serializeCalls(call) : call };
  } catch (error) {
    await client.close();
    throw error;
  }
}
