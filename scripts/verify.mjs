#!/usr/bin/env node
// Integration checks use temporary HOME/config/profile and never need Tunnel credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

const options = new Set(process.argv.slice(2));
for (const option of options) if (!['--desktop', '--browser'].includes(option)) throw new Error('Unknown option: ' + option);
const root = await mkdtemp(path.join(tmpdir(), 'remote-control-test-'));
const output = path.join(root, 'output');
await mkdir(output);
const browserPath = process.env.CRC_TEST_BROWSER ?? ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].flatMap(name => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name))).find(existsSync);
const browserConfig = {
  browser: {
    browserName: 'chromium', userDataDir: path.join(root, 'profile'),
    launchOptions: {
      ...(browserPath ? { executablePath: browserPath } : {}), headless: false, chromiumSandbox: true,
      ...(process.env.WAYLAND_DISPLAY ? { args: ['--ozone-platform=wayland'] } : {}),
      ...(process.env.CRC_TEST_PROXY ? { proxy: { server: process.env.CRC_TEST_PROXY, bypass: 'localhost,127.0.0.1,[::1]' } } : {}),
    },
    contextOptions: { viewport: { width: 1280, height: 800 }, acceptDownloads: true },
  },
  capabilities: ['core'], webmcp: false, imageResponses: 'allow', outputDir: output,
};
const configFile = path.join(root, 'config.json');
await writeFile(path.join(root, 'browser.json'), JSON.stringify(browserConfig));
await writeFile(configFile, JSON.stringify({ label: 'integration-test', workspace: root, desktop: { enabled: true }, browser: { enabled: true, configFile: 'browser.json' } }));
let client;
let fixture;
let calls = 0;

async function connect() {
  client = new Client({ name: 'remote-control-verification', version: '0.1.0' });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), CRC_CONFIG: configFile };
  delete env.CONTROL_PLANE_API_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/bridge.mjs', import.meta.url))], cwd: root, env, stderr: 'pipe' });
  const connected = client.connect(transport, { timeout: 30000 });
  transport.stderr?.on('data', () => {});
  await connected;
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  calls++;
  assert.ok(!result.isError, name + ' failed: ' + JSON.stringify(result.content).slice(0, 2000));
  return result;
}
async function snapshot(name) {
  const filename = path.join(root, name + '.yaml');
  await call('browser_snapshot', { filename });
  return readFile(filename, 'utf8');
}
async function files(dir) {
  const paths = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) paths.push(...await files(target));
    else paths.push(target);
  }
  return paths;
}
const passed = message => console.log('PASS ' + message);

try {
  await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 53);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 53);
  assert.equal(tools.filter(tool => tool.name.startsWith('browser_')).length, 25);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 2);
  for (const resource of resources.resources) assert.ok((await client.readResource({ uri: resource.uri })).contents.length);
  const resourceUris = new Set(resources.resources.map(resource => resource.uri));
  for (const tool of tools) {
    const uri = tool._meta?.ui?.resourceUri ?? tool._meta?.['openai/outputTemplate'];
    if (uri) assert.ok(resourceUris.has(uri), 'Unresolved UI resource');
  }
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
  assert.deepEqual((await client.listPrompts()).prompts, []);
  await client.setLoggingLevel('warning');
  passed('53 unique tools, all referenced resources readable, templates/prompts/logging compatible');
  const file = path.join(root, 'write.txt');
  const text = 'Remote file verification\n中文写入成功\n';
  await call('write_file', { path: file, content: text, mode: 'rewrite' });
  assert.equal(await readFile(file, 'utf8'), text);
  assert.ok((await call('read_file', { path: file })).content.some(block => block.type === 'text' && block.text.includes('中文写入成功')));
  passed('actual UTF-8 write/read roundtrip');
  const imageFile = path.join(root, 'synthetic.png');
  await sharp({ create: { width: 64, height: 32, channels: 3, background: '#268bd2' } }).png().toFile(imageFile);
  assert.ok((await call('read_file', { path: imageFile })).content.some(block => block.type === 'image'));
  passed('Desktop Commander image reading with patched native dependency');
  assert.equal((await client.callTool({ name: 'desktop_screenshot', arguments: { max_width: 1 } })).isError, true);
  if (options.has('--desktop')) {
    const info = await call('desktop_info');
    assert.ok(JSON.parse(info.content[0].text).monitors.length);
    for (const scope of ['desktop', 'active_window']) {
      const result = await call('desktop_screenshot', { scope, max_width: 1280, include_cursor: false });
      const image = result.content.find(block => block.type === 'image');
      assert.equal(image?.mimeType, 'image/jpeg');
      const bytes = Buffer.from(image.data, 'base64');
      const metadata = await sharp(bytes).metadata();
      assert.ok(metadata.width > 0 && metadata.width <= 1280);
      assert.ok((await sharp(bytes).stats()).entropy > 0.01);
    }
    passed('monitor information, full-desktop and active-window JPEG capture');
  }
  if (options.has('--browser')) {
    assert.ok(browserPath, 'Install Chrome/Chromium or set CRC_TEST_BROWSER.');
    const downloadText = 'Downloaded through browser\n下载成功\n';
    const html = `<!doctype html><meta charset="UTF-8"><title>Browser integration</title>
      <h1>浏览器控制验证</h1><form id="form"><label>姓名<input id="name"></label>
      <label><input id="agree" type="checkbox">同意测试</label><button>保存</button></form>
      <p id="result"></p><input id="upload" type="file"><p id="uploaded"></p>
      <a href="/download" id="download" download="verification.txt">下载</a><p id="previous"></p>
      <script>const get=id=>document.getElementById(id);get('previous').textContent='上次：'+localStorage.getItem('name')+' '+document.cookie;
      get('form').onsubmit=e=>{e.preventDefault();if(!get('agree').checked)return;localStorage.setItem('name',get('name').value);document.cookie='verification=passed;max-age=3600;path=/';get('result').textContent='已保存：'+get('name').value;};
      get('upload').onchange=async()=>get('uploaded').textContent=await get('upload').files[0].text();</script>`;
    fixture = createServer((req, res) => {
      if (req.url === '/download') { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="verification.txt"' }); res.end(downloadText); }
      else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${fixture.address().port}/`;
    await call('browser_navigate', { url });
    const page = await snapshot('initial');
    const saveRef = page.match(/button "保存" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(saveRef);
    await call('browser_fill_form', { fields: [
      { name: '姓名', target: '#name', type: 'textbox', value: '中文自动化验证' },
      { name: '同意测试', target: '#agree', type: 'checkbox', value: 'true' },
    ] });
    await call('browser_click', { target: saveRef });
    assert.ok((await snapshot('saved')).includes('已保存：中文自动化验证'));
    passed('visible browser, readable page structure, Chinese form, click by snapshot reference');
    await call('browser_click', { target: '#upload' });
    await call('browser_file_upload', { paths: [file] });
    await call('browser_wait_for', { text: '中文写入成功' });
    assert.ok((await snapshot('uploaded')).includes('中文写入成功'));
    await call('browser_click', { target: '#download' });
    let downloaded;
    for (let i = 0; i < 20; i++) {
      downloaded = (await files(output)).find(item => path.basename(item) === 'verification.txt');
      if (downloaded) break;
      await delay(250);
    }
    assert.ok(downloaded);
    assert.equal(await readFile(downloaded, 'utf8'), downloadText);
    passed('actual file upload/download with content verification');
    const image = (await call('browser_take_screenshot', { type: 'png', scale: 'css' })).content.find(block => block.type === 'image');
    assert.ok(image);
    assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).width, 1280);
    await call('browser_tabs', { action: 'new', url: url + '?second' });
    assert.ok((await call('browser_tabs', { action: 'list' })).content.some(block => block.type === 'text' && block.text.includes('?second')));
    await call('browser_tabs', { action: 'select', index: 0 });
    await call('browser_close');
    await client.close();
    await connect();
    await call('browser_navigate', { url });
    const reopened = await snapshot('reopened');
    assert.ok(reopened.includes('上次：中文自动化验证'));
    assert.ok(reopened.includes('verification=passed'));
    await call('browser_close');
    passed('browser screenshot, tabs, persistent cookies/local storage across a new bridge process');
  }
  console.log(`Integration checks passed (${calls} successful tool calls).`);
} finally {
  if (client) {
    if (options.has('--browser')) try { await client.callTool({ name: 'browser_close', arguments: {} }, undefined, { timeout: 10000 }); } catch {}
    await client.close();
  }
  if (fixture) await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  console.log('Temporary HOME, profiles, files and screenshots removed.');
}
