import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';
import { jobLogColors } from './logcolors.js';

const MAX_RUNNING_JOBS = 1;

export function createJobQueue({ table, profiles, stamps, jobDir, open, execute, close, cancelGraceMs }) {
  const running = new Map();
  let pumping = false;

  async function finish(job, ctx, code) {
    const status = jobStatus(ctx.state, code);
    try {
      await close(job, ctx, status);
    } catch (e) {
      console.error(`${table} ${job.id} : nettoyage incomplet :`, e.message);
    }
    if (ctx.log) {
      ctx.log.write(`\n=== ${status} (code ${code}) ===\n`);
      await ctx.log.close();
    }
    try {
      await pool.query(`UPDATE ${table} SET status = $2, exit_code = $3, finished_at = now() WHERE id = $1`, [job.id, status, code]);
      const stamp = stamps[job.action];
      if (status === 'success' && stamp && job.profile_id) {
        await pool.query(`UPDATE ${profiles} SET ${stamp} = now() WHERE id = $1`, [job.profile_id]);
      }
    } catch (e) {
      console.error(`${table} ${job.id} : statut non enregistré :`, e.message);
    }
  }

  async function run(job, state) {
    const ctx = { state, dir: jobDir(job.id), log: null };
    let code = 1;
    try {
      const logPath = path.join(ctx.dir, 'job.log');
      fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
      ctx.log = createJobLog(logPath, await jobLogColors());
      await pool.query(`UPDATE ${table} SET log_path = $2 WHERE id = $1`, [job.id, logPath]);
      Object.assign(ctx, await open(job));
      code = await execute(job, ctx);
    } catch (e) {
      if (ctx.log) ctx.log.write(`Erreur : ${e.message}\n`);
      else console.error(`${table} ${job.id} :`, e.message);
    }
    await finish(job, ctx, code);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (running.size < MAX_RUNNING_JOBS) {
        const { rows } = await pool.query(
          `UPDATE ${table} SET status = 'running', started_at = now()
           WHERE id = (SELECT id FROM ${table} WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`,
        );
        const job = rows[0];
        if (!job) break;
        const state = { child: null, cancelled: false };
        running.set(job.id, state);
        run(job, state).finally(() => {
          running.delete(job.id);
          pump();
        });
      }
    } catch (e) {
      console.error(`${table} : file d'attente indisponible :`, e.message);
    } finally {
      pumping = false;
    }
  }

  async function cancel(id) {
    const state = running.get(id);
    if (state) {
      state.cancelled = true;
      killGroup(state.child, 'SIGINT');
      setTimeout(() => killGroup(state.child, 'SIGKILL'), cancelGraceMs).unref();
      return true;
    }
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'`, [id],
    );
    return rowCount > 0;
  }

  async function recoverOrphans(cleanup) {
    const { rows } = await pool.query(
      `UPDATE ${table} SET status = 'failed', finished_at = now() WHERE status = 'running' RETURNING id`,
    );
    rows.forEach(({ id }) => cleanup(id));
  }

  return { pump, cancel, recoverOrphans };
}

function killGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

export const stripAnsi = (text) => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '');

const SECRET_MARK = '<secret>';

const maskXapiIdentifiers = (text) => text
  .replace(/session_id=[^\s&'"]+/gi, `session_id=${SECRET_MARK}`)
  .replace(/OpaqueRef:[0-9a-f][0-9a-f-]*/gi, `OpaqueRef:${SECRET_MARK}`);
const renamePackerSecrets = (text) => text.replaceAll('<sensitive>', SECRET_MARK);
const bracketQuotes = (text) => text.replace(/«[\s\u00a0\u202f]*/g, '[').replace(/[\s\u00a0\u202f]*»/g, ']');

const WORD_CHAR = String.raw`[\p{L}\p{N}_-]`;
const WHOLE_WORD_BELOW = 8;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function secretPattern(secret) {
  const body = escapeRegExp(secret);
  if (secret.length >= WHOLE_WORD_BELOW) return body;
  const before = new RegExp(`^${WORD_CHAR}`, 'u').test(secret) ? `(?<!${WORD_CHAR})` : '';
  const after = new RegExp(`${WORD_CHAR}$`, 'u').test(secret) ? `(?!${WORD_CHAR})` : '';
  return `${before}${body}${after}`;
}

function secretMasker() {
  const secrets = new Set();
  let re = null;
  return {
    add(...values) {
      values.filter(Boolean).forEach((v) => secrets.add(String(v)));
      const list = [...secrets].sort((a, b) => b.length - a.length);
      re = list.length ? new RegExp(list.map(secretPattern).join('|'), 'gu') : null;
    },
    mask: (text) => maskXapiIdentifiers(re ? String(text).replace(re, SECRET_MARK) : String(text)),
  };
}

function createJobLog(logPath, colors = true) {
  const stream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  stream.on('error', (e) => console.error(`journal ${logPath} :`, e.message));
  const masker = secretMasker();
  let pending = '';
  const mask = (text) => renamePackerSecrets(masker.mask(text));
  const line = (text) => bracketQuotes(mask(text));
  return {
    colors,
    addSecrets: (...values) => masker.add(...values),
    mask,
    write(chunk) {
      pending += chunk;
      const end = pending.lastIndexOf('\n') + 1;
      if (!end) return;
      stream.write(line(pending.slice(0, end)));
      pending = pending.slice(end);
    },
    maskFile(file, dest = file) {
      if (!fs.existsSync(file)) return;
      fs.writeFileSync(dest, mask(fs.readFileSync(file, 'utf8')), { mode: 0o600 });
      fs.chmodSync(dest, 0o600);
    },
    close: () => new Promise((resolve) => {
      if (pending) stream.write(line(pending));
      pending = '';
      stream.end(resolve);
    }),
  };
}

const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE', 'PACKER_PLUGIN_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

export function childEnv(extra) {
  const inherited = INHERITED_ENV.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]);
  return { ...Object.fromEntries(inherited), ...extra };
}

const TAIL_BYTES = 8192;

export function runCommand(command, args, { cwd, env, log, state, capture = false, tail = false }) {
  return new Promise((resolve) => {
    log.write(`\n$ ${command} ${args.join(' ')}\n`);
    let stdout = '';
    let last = '';
    const keep = (d) => { if (tail) last = (last + d).slice(-TAIL_BYTES); };
    const child = spawn(command, args, { cwd, env, detached: true });
    state.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      keep(d);
      if (capture) stdout += d;
      else log.write(d);
    });
    child.stderr.on('data', (d) => {
      keep(d);
      log.write(d);
    });
    child.on('error', (e) => {
      log.write(`Erreur de lancement : ${e.message}\n`);
      resolve({ code: 127, stdout, tail: last });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, tail: last }));
  });
}

const jobStatus = (state, exitCode) => (state.cancelled ? 'cancelled' : exitCode === 0 ? 'success' : 'failed');
