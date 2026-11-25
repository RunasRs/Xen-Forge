import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const LOCK_ID = 7314;

function migrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Migration ${file} : nom attendu NNN_nom.sql`);
    return { version: Number(m[1]), file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') };
  }).map((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration ${m.file} : numéro ${String(i + 1).padStart(3, '0')} attendu`);
    return m;
  });
}

const createdTables = (sql) => [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]);

async function baseline(client, first) {
  const { rows: [{ legacy }] } = await client.query("SELECT to_regclass('public.settings') IS NOT NULL AS legacy");
  if (!legacy) return false;
  const tables = createdTables(first.sql);
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)", [tables]);
  const missing = tables.filter((t) => !rows.some((r) => r.tablename === t));
  if (missing.length) throw new Error(`Base existante incomplète, migration ${first.file} impossible à marquer : ${missing.join(', ')}`);
  await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [first.version, first.file]);
  console.log(`Base existante : migration ${first.file} marquée appliquée`);
  return true;
}

export async function runMigrations() {
  const migrations = migrationFiles();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    const { rows: [{ fresh }] } = await client.query("SELECT to_regclass('public.schema_migrations') IS NULL AS fresh");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    if (fresh && migrations.length) await baseline(client, migrations[0]);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    for (const m of migrations.filter((x) => !applied.has(x.version))) {
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.file} en échec, annulée : ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
