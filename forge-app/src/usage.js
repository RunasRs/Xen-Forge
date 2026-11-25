import { pool } from './db.js';

const TABLES = { packer: 'profiles', tofu: 'tofu_profiles', ansible: 'ansible_profiles' };
const PLACES = { packer: 'Packer > Profils', tofu: 'OpenTofu > Profils', ansible: 'Ansible > Profils' };

const stepValues = (vars) => (vars.steps || []).flatMap((s) => Object.values(s.values || {}).flat());

const VAULT_REFERENCES = {
  packer: (vars) => [vars.safe_entry_id, vars.product_key_entry_id],
  tofu: (vars) => [vars.safe_entry_id, vars.product_key_entry_id],
  ansible: (vars) => [...(vars.targets || []).flatMap((t) => [t.safe_entry_id, t.become_entry_id]), ...stepValues(vars)],
};
const CERTIFICATE_REFERENCES = {
  ansible: (vars) => [...(vars.targets || []).map((t) => t.ca_certificate_id), ...stepValues(vars)],
};

const CONNECTOR_CAS = `
  SELECT ca_certificate_id::text AS id, 'XCP-ng ' || host AS name, 'Infrastructure > Connecteurs' AS place FROM xcp_hosts WHERE ca_certificate_id IS NOT NULL AND NOT insecure
  UNION ALL
  SELECT ca_certificate_id::text, 'LDAP ' || domain, 'Authentification > Domaine (LDAP)' FROM ldap_configs WHERE ca_certificate_id IS NOT NULL AND tls
  UNION ALL
  SELECT value, 'Xen Orchestra', 'Infrastructure > Connecteurs' FROM settings WHERE key = 'xo_ca_id' AND value <> ''
    AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'xo_insecure' AND value = 'true')`;

async function usageIndex(references, connectors = false) {
  const index = new Map();
  const add = (id, user) => {
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(user);
  };
  if (connectors) (await pool.query(CONNECTOR_CAS)).rows.forEach((r) => add(r.id, { engine: 'connector', name: r.name, place: r.place }));
  for (const [engine, pick] of Object.entries(references)) {
    const { rows } = await pool.query(`SELECT name, vars FROM ${TABLES[engine]} ORDER BY name`);
    for (const p of rows) {
      for (const id of new Set(pick(p.vars || {}).filter(Boolean).map(String))) add(id, { engine, name: p.name });
    }
  }
  return (id) => index.get(String(id)) || [];
}

export const vaultUsers = () => usageIndex(VAULT_REFERENCES);
export const certificateUsers = () => usageIndex(CERTIFICATE_REFERENCES, true);
const SHOWN = 5;
export const usersLabel = (users) => [users.slice(0, SHOWN).map((u) => `« ${u.name} » [${u.place || PLACES[u.engine]}]`).join(', '),
  users.length > SHOWN ? ` et ${users.length - SHOWN} autre${users.length - SHOWN > 1 ? 's' : ''}` : ''].join('');
