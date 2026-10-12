import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, readdir, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const terminalStatus = status => ['completed', 'failed', 'interrupted', 'not_sent'].includes(status);
export const taskIdFor = requestId => 'work_' + createHash('sha256').update(requestId).digest('hex');
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class WorkStore {
  constructor(directory) { this.directory = directory; }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Work state directory must be owned by the current user.');
    await chmod(this.directory, 0o700);
  }
  filename(taskId) {
    if (!/^work_[a-f0-9]{64}$/.test(taskId)) throw new Error('Invalid task_id.');
    return path.join(this.directory, taskId + '.json');
  }
  async get(taskId) {
    try {
      const file = this.filename(taskId);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid Work task record.');
      const task = JSON.parse(await readFile(file, 'utf8'));
      if (task.task_id !== taskId) throw new Error('Invalid Work task identity.');
      return task;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(task) {
    await this.initialize();
    const filename = this.filename(task.task_id);
    const temporary = filename + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(task) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await rename(temporary, filename);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async list() {
    await this.initialize();
    const entries = (await readdir(this.directory)).filter(name => /^work_[a-f0-9]{64}\.json$/.test(name));
    const tasks = [];
    for (const name of entries) { const task = await this.get(name.slice(0, -5)); if (task) tasks.push(task); }
    return tasks;
  }
  async withMutationLease(callback) {
    await this.initialize();
    const filename = path.join(this.directory, '.mutation.lock');
    const handle = await open(filename, 'a', 0o600);
    await handle.close();
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid Work mutation lock.');
    await chmod(filename, 0o600);
    const env = { ...process.env }; delete env.CONTROL_PLANE_API_KEY;
    // Kernel flock releases on exit/crash; no stale PID locks or timed lease can admit a second sender.
    const holder = spawn('flock', ['--exclusive', '--timeout', '15', filename, process.execPath, '-e', 'process.stdout.write("locked\\n");process.stdin.resume();'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let acquired = false;
    const exited = new Promise(resolve => holder.once('close', resolve));
    try {
      await new Promise((resolve, reject) => {
        holder.once('error', () => reject(new Error('Work bridge requires the Linux flock utility.')));
        holder.stdout.once('data', data => { if (data.toString().startsWith('locked')) { acquired = true; resolve(); } else reject(new Error('Invalid Work lock acknowledgement.')); });
        holder.once('exit', () => { if (!acquired) reject(new Error('Work bridge is busy acquiring its task journal lock.')); });
        holder.stderr.resume();
      });
      return await callback();
    } finally {
      holder.stdin.end();
      if (!acquired) holder.kill();
      await exited;
    }
  }
}

async function firstLine(filename) {
  const handle = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return null;
    const row = JSON.parse(text.slice(0, end));
    return row.type === 'session_meta' ? row.payload : null;
  } finally { await handle.close(); }
}

export async function listLocalChats(config, limit = 20) {
  const eligible = row => (!config.allowedThreadIds.length || config.allowedThreadIds.includes(row.id)) && (config.allowCodexThreads || row.originator === 'codex_work_desktop');
  // SQLite is optional on early Node 22; metadata-only rollout scanning is the fallback.
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const entries = (await readdir(config.codexHome)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (entries[0]) {
      const db = new DatabaseSync(path.join(config.codexHome, entries[0]), { readOnly: true });
      try {
        const rows = db.prepare('SELECT id, title, cwd, originator, updated_at, archived FROM threads WHERE archived = 0 ORDER BY updated_at DESC').all();
        return rows.filter(eligible).slice(0, limit).map(row => ({ thread_id: row.id, title: row.title, cwd: row.cwd, originator: row.originator, updated_at: row.updated_at, requires_open_chat: true }));
      } finally { db.close(); }
    }
  } catch (error) { if (error.code !== 'ENOENT' && !/sqlite|module|column|table/i.test(error.message)) throw error; }
  const files = [];
  async function walk(directory, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path.join(directory, entry.name));
    }
  }
  await walk(path.join(config.codexHome, 'sessions'), 0);
  files.sort().reverse();
  const rows = [];
  const seen = new Set();
  for (const file of files) {
    if (rows.length >= limit) break;
    let meta;
    try { meta = await firstLine(file); } catch { continue; }
    if (!meta || seen.has(meta.id) || !eligible(meta)) continue;
    seen.add(meta.id);
    rows.push({ thread_id: meta.id, title: null, cwd: meta.cwd, originator: meta.originator, requires_open_chat: true });
  }
  return rows;
}

export async function listLocalSkills(codexHome, limit = 100) {
  const skills = [];
  async function walk(directory, depth) {
    if (depth > 9 || skills.length >= limit) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (['node_modules', '.git', 'references', 'assets', 'scripts'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        const stat = await lstat(file);
        if (stat.size > 256 * 1024) continue;
        const text = await readFile(file, 'utf8');
        const name = text.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() || path.basename(directory);
        skills.push({ name, path: file });
        if (skills.length >= limit) return;
      }
    }
  }
  await walk(path.join(codexHome, 'skills'), 0);
  await walk(path.join(codexHome, 'plugins', 'cache'), 0);
  return skills;
}
