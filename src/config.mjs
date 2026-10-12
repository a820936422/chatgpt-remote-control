import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = (value, base, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Paths must be nonempty strings.');
  return path.resolve(base, value);
};
const enabled = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('enabled must be a boolean.');
  return value;
};
const command = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('Executable paths must be nonempty strings.');
  return value;
};

export function normalizeConfig(raw, filename) {
  if (!object(raw)) throw new Error('Configuration must be a JSON object.');
  for (const key of ['desktop', 'browser', 'work']) if (raw[key] !== undefined && !object(raw[key])) throw new Error(`${key} must be an object.`);
  const base = path.dirname(path.resolve(filename));
  const label = raw.label ?? os.hostname();
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\x00-\x1f]/.test(label)) throw new Error('label must be a short nonempty string.');
  const work = raw.work ?? {};
  const codexHome = absolute(work.codexHome, base, path.join(os.homedir(), '.codex'));
  const allowedThreadIds = work.allowedThreadIds ?? [];
  if (!Array.isArray(allowedThreadIds) || allowedThreadIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) throw new Error('work.allowedThreadIds must contain thread UUIDs.');
  const requestTimeoutMs = work.requestTimeoutMs ?? 10000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 30000) throw new Error('work.requestTimeoutMs must be between 1000 and 30000.');
  return {
    label,
    workspace: absolute(raw.workspace, base, os.homedir()),
    uiPreviews: enabled(raw.uiPreviews, false),
    desktop: {
      enabled: enabled(raw.desktop?.enabled, true),
      spectaclePath: command(raw.desktop?.spectaclePath, 'spectacle'),
      kscreenDoctorPath: command(raw.desktop?.kscreenDoctorPath, 'kscreen-doctor'),
    },
    browser: {
      enabled: enabled(raw.browser?.enabled, true),
      configFile: absolute(raw.browser?.configFile, base, path.join(base, 'browser.json')),
    },
    work: {
      enabled: enabled(work.enabled, false),
      codexHome,
      socketPath: absolute(work.socketPath, base, path.join(codexHome, 'ipc', 'ipc.sock')),
      stateDirectory: absolute(work.stateDirectory, base, path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'chatgpt-remote-control', 'work')),
      allowedThreadIds: [...new Set(allowedThreadIds)],
      allowCodexThreads: enabled(work.allowCodexThreads, false),
      requestTimeoutMs,
    },
  };
}

export async function loadConfig(filename = process.env.CRC_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'chatgpt-remote-control', 'config.json')) {
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  return normalizeConfig(raw, filename);
}

export function childEnvironment(env = process.env) {
  const clean = { ...env };
  // The Tunnel needs its key. MCP servers and the browser do not.
  delete clean.CONTROL_PLANE_API_KEY;
  return clean;
}
