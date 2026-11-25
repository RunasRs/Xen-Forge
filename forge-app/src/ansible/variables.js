import { parseDocument } from 'yaml';
import { pool } from '../db.js';
import { IPV4_RE, UUID_RE, ValidationError } from '../validation.js';
import { OS_TYPES, checkStepValues, resolveStepBrick } from './catalogue.js';

const CONFIG_TYPES = ['guided', 'yaml'];
const CONNECTIONS = { linux: ['ssh'], windows: ['ssh', 'winrms'] };
const DEFAULT_PORTS = { ssh: 22, winrms: 5986 };
const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const FQDN_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}))*$/;
const MAX_TARGETS = 50;
const MAX_STEPS = 50;
const MAX_PLAYBOOK_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MIN = 60;
const MAX_TIMEOUT_MIN = 1440;
const DEFAULT_FORKS = 5;
const MAX_FORKS = 20;

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function intIn(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} : nombre entier de ${min} à ${max}`);
  return n;
}

function optionalUuid(value, label, kind = 'entrée du coffre-fort') {
  if (value === undefined || value === null || value === '') return '';
  if (!UUID_RE.test(String(value))) throw new ValidationError(`${label} : ${kind} invalide`);
  return String(value);
}

async function forgeVms(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query('SELECT id, name, vars FROM tofu_profiles WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

async function checkTargets(list, os) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError('Cibles : liste attendue');
  if (list.length > MAX_TARGETS) throw new ValidationError(`Cibles : ${MAX_TARGETS} serveurs au plus`);
  const vms = await forgeVms([...new Set(list.filter((t) => isMapping(t) && UUID_RE.test(String(t.tofu_profile_id)))
    .map((t) => String(t.tofu_profile_id)))]);
  const names = new Set();
  const seenVms = new Set();
  return list.map((t, i) => {
    const at = `Cible ${i + 1}`;
    if (!isMapping(t)) throw new ValidationError(`${at} : dictionnaire attendu`);
    const source = t.source === 'forge' ? 'forge' : t.source === 'manual' ? 'manual' : null;
    if (!source) throw new ValidationError(`${at} : source « forge » ou « manual » attendue`);
    const target = { source };
    if (source === 'forge') {
      const id = String(t.tofu_profile_id || '');
      const vm = UUID_RE.test(id) && vms.get(id);
      if (!vm) throw new ValidationError(`${at} : profil OpenTofu introuvable`);
      if ((vm.vars?.os_type || 'linux') !== os) throw new ValidationError(`${at} : la VM « ${vm.vars?.vm_name} » n'est pas sous ${os === 'windows' ? 'Windows' : 'Linux'}`);
      if (seenVms.has(id)) throw new ValidationError(`${at} : VM « ${vm.vars?.vm_name} » déjà ciblée`);
      seenVms.add(id);
      target.tofu_profile_id = id;
      target.name = String(vm.vars?.vm_name || vm.name).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\w .-]/g, '-').slice(0, 63);
    } else {
      const name = String(t.name || '').trim();
      if (!TARGET_NAME_RE.test(name)) throw new ValidationError(`${at} : nom invalide (lettres, chiffres, « . », « _ », « - », 63 caractères max)`);
      const address = String(t.address || '').trim();
      if (/^[\d.]+$/.test(address) ? !IPV4_RE.test(address) : !FQDN_RE.test(address)) throw new ValidationError(`${at} (${name}) : adresse IPv4 ou nom de domaine attendu`);
      target.name = name;
      target.address = address;
    }
    if (names.has(target.name.toLowerCase())) throw new ValidationError(`${at} : nom « ${target.name} » déjà utilisé dans ce profil`);
    names.add(target.name.toLowerCase());
    const connection = String(t.connection || 'ssh');
    if (!CONNECTIONS[os].includes(connection)) {
      throw new ValidationError(`${at} (${target.name}) : connexion ${CONNECTIONS[os].map((c) => (c === 'ssh' ? 'SSH' : 'WinRM HTTPS')).join(' ou ')} attendue`);
    }
    target.connection = connection;
    target.port = intIn(t.port, 1, 65535, DEFAULT_PORTS[connection], `${at} (${target.name}), port`);
    if (!UUID_RE.test(String(t.safe_entry_id || ''))) throw new ValidationError(`${at} (${target.name}) : entrée du coffre-fort obligatoire`);
    target.safe_entry_id = String(t.safe_entry_id);
    if (os === 'linux') {
      const become = optionalUuid(t.become_entry_id, `${at} (${target.name}), mot de passe sudo`);
      if (become) target.become_entry_id = become;
    }
    if (connection === 'winrms') {
      const ca = optionalUuid(t.ca_certificate_id, `${at} (${target.name}), vérification du certificat`, 'autorité de certification');
      if (ca) target.ca_certificate_id = ca;
    }
    return target;
  });
}

function checkSteps(list, os) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError('Étapes : liste attendue');
  if (list.length > MAX_STEPS) throw new ValidationError(`Étapes : ${MAX_STEPS} au plus`);
  return list.map((s, i) => {
    const at = `Étape ${i + 1}`;
    if (!isMapping(s)) throw new ValidationError(`${at} : dictionnaire attendu`);
    const brick = resolveStepBrick({ brick: String(s.brick || '') }, os, at);
    return {
      brick: brick.id,
      enabled: s.enabled !== false && s.enabled !== 'false',
      values: checkStepValues(brick, s.values, `${at} (${brick.name})`),
    };
  });
}

async function checkCertificates(steps, os) {
  const uses = steps.flatMap((s, i) => {
    const brick = resolveStepBrick(s, os, `Étape ${i + 1}`);
    return brick.parameters.filter((p) => p.type === 'certificate_entry' && s.values[p.name])
      .map((p) => ({ id: s.values[p.name], types: p.cert_types, at: `Étape ${i + 1} (${brick.name}), ${p.label}` }));
  });
  if (!uses.length) return;
  const { rows } = await pool.query('SELECT id, name, type, is_active FROM certificate_entries WHERE id = ANY($1)', [uses.map((u) => u.id)]);
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const u of uses) {
    const c = found.get(u.id);
    if (!c) throw new ValidationError(`${u.at} : certificat introuvable`);
    if (!c.is_active) throw new ValidationError(`${u.at} : certificat « ${c.name} » désactivé`);
    if (!u.types.includes(c.type)) throw new ValidationError(`${u.at} : certificat « ${c.name} » d'un type non accepté par la brique`);
  }
}

function checkPlaybookText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ValidationError('Playbook YAML obligatoire');
  if (text.length > MAX_PLAYBOOK_CHARS) throw new ValidationError(`Playbook : ${MAX_PLAYBOOK_CHARS} caractères au plus`);
  const doc = parseDocument(text, { uniqueKeys: true, maxAliasCount: 100 });
  if (doc.errors.length) {
    const [err] = doc.errors;
    const line = err.linePos?.[0]?.line;
    throw new ValidationError(`Playbook : YAML invalide${line ? ` (ligne ${line})` : ''} : ${err.message.split('\n')[0]}`);
  }
  let plays;
  try {
    plays = doc.toJS({ maxAliasCount: 100 });
  } catch {
    throw new ValidationError('Playbook : trop d\'alias YAML (* : 100 au plus)');
  }
  if (!Array.isArray(plays) || !plays.length || !plays.every(isMapping)) {
    throw new ValidationError('Playbook : liste de plays attendue (chaque play commence par « - name: … »)');
  }
  const bad = plays.findIndex((p) => !('hosts' in p) && !('import_playbook' in p) && !('ansible.builtin.import_playbook' in p));
  if (bad >= 0) throw new ValidationError(`Playbook : le play ${bad + 1} n'a pas de « hosts » (utiliser « hosts: all »)`);
  return text.replace(/\r\n?/g, '\n');
}

export async function validateAnsibleProfile(input) {
  if (!isMapping(input)) throw new ValidationError('Variables du profil manquantes');
  const os = String(input.os_type || '');
  if (!OS_TYPES.includes(os)) throw new ValidationError('OS : Linux ou Windows');
  const type = String(input.config_type || '');
  if (!CONFIG_TYPES.includes(type)) throw new ValidationError('Type de configuration : guidée ou YAML');
  const vars = {
    os_type: os,
    config_type: type,
    targets: await checkTargets(input.targets, os),
    timeout_min: intIn(input.timeout_min, 0, MAX_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN, 'Délai maximal (min)'),
    forks: intIn(input.forks, 1, MAX_FORKS, DEFAULT_FORKS, 'Serveurs en parallèle'),
  };
  if (type === 'guided') {
    vars.steps = checkSteps(input.steps, os);
    await checkCertificates(vars.steps, os);
  }
  else vars.playbook = checkPlaybookText(input.playbook);
  return vars;
}

export function ansibleUpdateRefusal(cur, next) {
  if (cur.os_type !== next.os_type) return 'L\'OS d\'un profil Ansible ne change pas : créer un autre profil';
  if (cur.config_type !== next.config_type) return 'Le type de configuration ne change pas : utiliser « Convertir en YAML » ou créer un autre profil';
  return null;
}
