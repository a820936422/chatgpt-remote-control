import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { childEnvironment } from './config.mjs';

const run = promisify(execFile);
const imageLimit = 3 * 1024 * 1024;

export function validateCapture(args = {}) {
  checkArguments(args, ['scope', 'max_width', 'include_cursor']);
  const { scope = 'desktop', max_width: maxWidth = 1920, include_cursor: includeCursor = true } = args;
  if (!['desktop', 'active_window'].includes(scope)) throw new Error('scope must be desktop or active_window.');
  if (!Number.isInteger(maxWidth) || maxWidth < 640 || maxWidth > 3840) throw new Error('max_width must be an integer from 640 to 3840.');
  if (typeof includeCursor !== 'boolean') throw new Error('include_cursor must be a boolean.');
  return { scope, maxWidth, includeCursor };
}

function checkArguments(args, allowedKeys) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('Arguments must be an object.');
  for (const key of Object.keys(args)) if (!allowedKeys.includes(key)) throw new Error('Unknown argument: ' + key);
}

function checkSession() {
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) throw new Error('No graphical session is available. Log in to the KDE desktop and restart the user service.');
}

export function createDesktop(config) {
  let capturing = false;
  const tools = config.desktop.enabled ? [
    {
      name: 'desktop_screenshot',
      title: 'Capture the local desktop',
      description: `Capture the logged-in KDE desktop on ${config.label} as standard MCP image content. Visual interpretation requires client image support; JPEG bytes or dimensions alone are not visual understanding. scope=desktop captures all monitors; active_window captures the active window. Use browser_snapshot for web page structure. This tool does not send keyboard or mouse input.`,
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['desktop', 'active_window'], default: 'desktop' },
          max_width: { type: 'integer', minimum: 640, maximum: 3840, default: 1920, description: 'Maximum image width; preserves aspect ratio without upscaling.' },
          include_cursor: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'desktop_info',
      title: 'Inspect local monitors',
      description: `Return connected monitor names, logical layout, resolution, scale, and refresh rate on ${config.label}. Requires a KDE graphical session. Does not capture screen contents.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ] : [];

  async function info(args, signal) {
    checkArguments(args, []);
    checkSession();
    const { stdout } = await run(config.desktop.kscreenDoctorPath, ['-j'], { timeout: 8000, maxBuffer: 1024 * 1024, signal, env: childEnvironment() });
    const data = JSON.parse(stdout);
    const monitors = (data.outputs ?? []).filter(output => output.connected).map(output => {
      const mode = (output.modes ?? []).find(item => item.id === output.currentModeId);
      return {
        name: output.name, enabled: output.enabled, logical_position: output.pos,
        logical_size: output.size, scale: output.scale, rotation: output.rotation,
        pixel_resolution: mode?.size, refresh_hz: mode?.refreshRate,
      };
    });
    return { content: [{ type: 'text', text: JSON.stringify({ hostname: config.label, session: process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11', monitors, screen: data.screen }, null, 2) }] };
  }

  async function screenshot(args, signal) {
    const { scope, maxWidth, includeCursor } = validateCapture(args);
    checkSession();
    if (capturing) throw new Error('A screenshot is already being captured. Retry when it completes.');
    capturing = true;
    let directory;
    try {
      directory = await mkdtemp(path.join(tmpdir(), 'chatgpt-screen-'));
      const file = path.join(directory, 'capture.png');
      const options = ['--background', '--nonotify', '--output', file];
      if (scope === 'desktop') options.push('--fullscreen', '--scaled');
      else options.push('--activewindow');
      if (includeCursor) options.push('--pointer');
      await run(config.desktop.spectaclePath, options, { timeout: 20000, maxBuffer: 512 * 1024, signal, env: childEnvironment() });
      const input = sharp(file, { limitInputPixels: 100_000_000 });
      const original = await input.metadata();
      let image = await input.resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      if (image.length > imageLimit) image = await sharp(file, { limitInputPixels: 100_000_000 }).resize({ width: Math.min(maxWidth, 1600), withoutEnlargement: true }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
      if (image.length > imageLimit) throw new Error('Screenshot is too large; use active_window or a smaller max_width.');
      const returned = await sharp(image).metadata();
      return { content: [
        { type: 'text', text: JSON.stringify({ hostname: config.label, captured_at: new Date().toISOString(), scope, original_width: original.width, original_height: original.height, returned_width: returned.width, returned_height: returned.height, image_format: 'image/jpeg', temporary_capture_deleted: true }) },
        { type: 'image', mimeType: 'image/jpeg', data: image.toString('base64') },
      ] };
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { capturing = false; }
    }
  }

  async function call(name, args, signal) {
    try {
      if (!config.desktop.enabled) throw new Error('Desktop tools are disabled.');
      if (name === 'desktop_info') return await info(args, signal);
      if (name === 'desktop_screenshot') return await screenshot(args, signal);
      throw new Error('Unknown desktop tool.');
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: signal?.aborted ? 'Desktop request cancelled.' : error.message }] };
    }
  }
  return { tools, call };
}
