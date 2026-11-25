import { pool } from '../db.js';
import { UUID_RE } from '../validation.js';

const STATE_TTL_MS = 60000;
const MISSING_SCHEMA = '3F000';
const MISSING_TABLE = '42P01';

const stateCache = new Map();

export const stateSchema = (profileId) => `tofu_${String(profileId).replace(/-/g, '').toLowerCase()}`;

export const forgetState = (profileId) => stateCache.delete(String(profileId).toLowerCase());

function assertUuid(id) {
  if (!UUID_RE.test(String(id))) throw new Error('Identifiant de profil invalide');
}

async function readStateSummary(profileId) {
  let rows;
  try {
    ({ rows } = await pool.query(`SELECT data FROM ${stateSchema(profileId)}.states WHERE name = 'default'`));
  } catch (e) {
    if (e.code === MISSING_SCHEMA || e.code === MISSING_TABLE) return null;
    throw e;
  }
  if (!rows[0]?.data) return null;
  const state = JSON.parse(rows[0].data);
  const resources = (state.resources || []).filter((r) => r.mode === 'managed');
  const vm = resources.find((r) => r.type === 'xenorchestra_vm')?.instances?.[0]?.attributes;
  return {
    resources: resources.length,
    vm: vm ? { id: vm.id, name: vm.name_label, ipv4: vm.ipv4_addresses || [], share: vm.share === true, power: vm.power_state || '' } : null,
  };
}

export async function tofuStateSummary(profileId, { fresh = false } = {}) {
  assertUuid(profileId);
  const key = String(profileId).toLowerCase();
  const hit = stateCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < STATE_TTL_MS) return hit.value;
  const value = readStateSummary(profileId);
  stateCache.set(key, { at: Date.now(), value });
  value.catch(() => { if (stateCache.get(key)?.value === value) stateCache.delete(key); });
  return value;
}

export async function dropTofuState(profileId) {
  assertUuid(profileId);
  await pool.query(`DROP SCHEMA IF EXISTS ${stateSchema(profileId)} CASCADE`);
  forgetState(profileId);
}
