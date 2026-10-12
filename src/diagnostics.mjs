import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const fields = [
  'component', 'method', 'event', 'trace_id', 'name', 'owner', 'pid', 'ts',
  'elapsed_ms', 'inflight', 'attempt', 'error_class', 'retry_delay_ms', 'ok',
];
const numbers = new Set(['pid', 'elapsed_ms', 'inflight', 'attempt', 'retry_delay_ms']);
const words = new Set(['component', 'event', 'name', 'owner', 'error_class']);
const warning = 'Bridge diagnostics unavailable; tool execution continues.\n';

function sanitized(entry) {
  const result = {};
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return result;
  for (const field of fields) {
    if (!Object.hasOwn(entry, field)) continue;
    const value = entry[field];
    if (numbers.has(field)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[field] = value;
    } else if (field === 'ok') {
      if (typeof value === 'boolean') result[field] = value;
    } else if (field === 'error_class' && value === null) result[field] = null;
    else if (words.has(field)) {
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(value)) result[field] = value;
    } else if (field === 'method') {
      if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z][A-Za-z0-9_.-]*){0,3}$/.test(value) && value.length <= 160) result[field] = value;
    } else if (field === 'trace_id') {
      if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) result[field] = value;
    } else if (field === 'ts') {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))) result[field] = value;
    }
  }
  return result;
}

function uid() {
  if (typeof process.getuid !== 'function') throw new Error('Same-user filesystem checks are unavailable.');
  return process.getuid();
}

function checkAncestors(directory, owner) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner && stat.uid !== 0) throw new Error('Unsafe diagnostics directory path.');
  }
}

function privateDirectory(directory, owner) {
  checkAncestors(directory, owner);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || stat.uid !== owner) throw new Error('Diagnostics directory must belong to the current user.');
    fs.fchmodSync(descriptor, 0o700);
  } finally { fs.closeSync(descriptor); }
}

function checkFile(filename, owner) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== owner) throw new Error('Unsafe diagnostics log file.');
  return stat;
}

function openLog(filename, owner) {
  const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== owner) throw new Error('Diagnostics log must belong to the current user.');
    fs.fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** A synchronous private diagnostic sink; failures never change a tool receipt. */
export function createDiagnosticLogger(settings = {}) {
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    try { process.stderr.write(warning); } catch {}
  };
  return entry => {
    let line;
    try { line = JSON.stringify(sanitized(entry)) + '\n'; }
    catch { warn(); return; }
    // Preserve exactly the same sanitized entry for systemd journal diagnostics.
    try { process.stderr.write(line); } catch { warn(); }
    try {
      const state = settings.stateDirectory;
      if (typeof state !== 'string' || !path.isAbsolute(state) || /[\x00-\x1f\x7f]/.test(state)) throw new Error('Invalid diagnostics state directory.');
      const owner = uid();
      privateDirectory(state, owner);
      const directory = path.join(state, 'diagnostics');
      privateDirectory(directory, owner);
      const filename = path.join(directory, `bridge-${process.pid}.jsonl`);
      const previous = filename + '.1';
      const data = Buffer.from(line, 'utf8');
      const current = checkFile(filename, owner);
      if (current && current.size + data.length > MAX_BYTES) {
        checkFile(previous, owner);
        const secured = openLog(filename, owner);
        fs.closeSync(secured);
        fs.renameSync(filename, previous);
        syncDirectory(directory);
      }
      const descriptor = openLog(filename, owner);
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = fs.writeSync(descriptor, data, offset, data.length - offset);
          if (written <= 0) throw new Error('Diagnostics append did not complete.');
          offset += written;
        }
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      syncDirectory(directory);
    } catch { warn(); }
  };
}
