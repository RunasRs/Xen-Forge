import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { DATA_DIR, pool } from '../db.js';
import { saveFiles } from '../archive.js';
import { createJobQueue, stripAnsi } from '../runner.js';
import { resolveForJob } from '../safe.js';
import { resolveForJob as resolveCertificate } from '../certificates.js';
import { tofuStateSummary } from '../tofu/state.js';
import { onlyLinkLocal, waitRoutableIp } from '../tofu/vmsettings.js';
import { checkStepValues, resolveStepBrick } from './catalogue.js';
import { certKeys, guidedPlaybook, inventoryText, pingPlaybook, vaultKeys } from './playbook.js';
import { workFiles } from './workfiles.js';
import { UUID_RE } from '../validation.js';

const JOBS_ROOT = path.join(DATA_DIR, 'jobs-ansible');
const WORK_ROOT = path.join(DATA_DIR, 'ansible-work');
const IDENT = 'run';
const POLL_MS = 500;
const PICKUP_TIMEOUT_MS = 60000;
const STDOUT_CHUNK = 1024 * 1024;
const RESULT_MAX = 64 * 1024;
const KNOWN_HOSTS_MAX = 1024 * 1024;
const EVENT_MAX = 4 * 1024 * 1024;
const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host Key checking is enabled/;
const ACTION_LABELS = { ping: 'test de connexion', check: 'vérification (aucune modification)', apply: 'application' };
const CONNECTION_LABELS = { ssh: 'SSH', winrms: 'WinRM HTTPS' };

export const ansibleJobDir = (id) => path.join(JOBS_ROOT, id);
function workDir(id) {
  fs.mkdirSync(WORK_ROOT, { recursive: true, mode: 0o700 });
  return path.join(fs.realpathSync(WORK_ROOT), id);
}

const queue = createJobQueue({
  table: 'ansible_jobs', profiles: 'ansible_profiles', stamps: { check: 'checked_at', apply: 'applied_at' },
  jobDir: ansibleJobDir, open: openJob, execute: executeJob, close: closeJob, cancelGraceMs: 0,
});
export const { pump: ansiblePump, cancel: cancelAnsible } = queue;

function abandonWork(id) {
  const work = workDir(id);
  const files = workFiles(work);
  if (!files.intact()) {
    fs.rmSync(work, { force: true });
    return;
  }
  files.remove('ready');
  if (files.present('started')) files.signal('cancel');
  for (const secret of ['inventory', 'keys']) files.remove(secret);
}

const ALIVE_FILE = path.join(WORK_ROOT, '.supervisor-alive');
const ALIVE_MAX_AGE_MS = 30000;

export function ansibleRunnerStatus() {
  let checked;
  try {
    const st = fs.lstatSync(ALIVE_FILE);
    if (!st.isFile()) throw new Error('not a file');
    checked = st.mtime;
  } catch {
    return { state: 'down', error: 'Aucun signe de vie de forge-ansible : conteneur absent ou jamais démarré' };
  }
  return Date.now() - checked.getTime() <= ALIVE_MAX_AGE_MS
    ? { state: 'ok', host: 'forge-ansible', checked_at: checked }
    : { state: 'down', error: 'forge-ansible ne répond plus (signe de vie trop ancien)', checked_at: checked };
}

function sweepWorkDirs() {
  let entries = [];
  try {
    entries = fs.readdirSync(WORK_ROOT);
  } catch {
    return;
  }
  for (const id of entries.filter((e) => UUID_RE.test(e))) {
    const work = workDir(id);
    const files = workFiles(work);
    if (files.present('result.json') || !files.present('started')) fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function recoverOrphanAnsibleJobs() {
  await queue.recoverOrphans(abandonWork);
  sweepWorkDirs();
}

export async function enqueueAnsible(profile, action) {
  const { rows } = await pool.query(
    'INSERT INTO ansible_jobs (profile_id, action, vars_snapshot) VALUES ($1, $2, $3) RETURNING *',
    [profile.id, action, { ...profile.vars, profile: profile.name }],
  );
  ansiblePump();
  return rows[0];
}

export const knownHostToken = (address, port) => (Number(port) === 22 ? address : `[${address}]:${port}`);

const keySecrets = (key) => [key.trim(), ...key.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'))];
const SECRET_HOST_VARS = new Set(['ansible_password', 'ansible_become_password']);
const SECRET_VAULT_FIELDS = new Set(['password', 'private_key']);
const hideFields = (obj, fields) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fields.has(k) ? '<secret>' : v]));
const SECRET_CERT_FIELDS = new Set(['private_key', 'pfx', 'pfx_password']);
const hideAll = (map, fields) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, hideFields(v, fields)]));
const archivedInventory = ({ hosts, vault, certs }) => inventoryText({
  hosts: hosts.map((h) => ({ ...h, vars: hideFields(h.vars, SECRET_HOST_VARS) })),
  vault: hideAll(vault, SECRET_VAULT_FIELDS),
  certs: hideAll(certs, SECRET_CERT_FIELDS),
});

const FORGE_IP_WAIT_MS = 2 * 60 * 1000;

async function liveAddress(target, vmId, log) {
  try {
    return await waitRoutableIp(vmId, { timeoutMs: FORGE_IP_WAIT_MS });
  } catch (e) {
    log?.write(`Cible ${target.name} : lecture de l'adresse dans XCP-ng impossible (${e.message}), adresse de l'état OpenTofu\n`);
    return null;
  }
}

export async function targetAddress(target, log) {
  if (target.source !== 'forge') return target.address;
  const { rows } = await pool.query('SELECT name, vars FROM tofu_profiles WHERE id = $1', [target.tofu_profile_id]);
  if (!rows[0]) throw new Error(`Cible ${target.name} : profil OpenTofu supprimé`);
  const st = await tofuStateSummary(target.tofu_profile_id, { fresh: true });
  if (!st?.resources) throw new Error(`Cible ${target.name} : VM détruite (profil OpenTofu « ${rows[0].name} » sans VM déployée)`);
  const live = st.vm?.id ? await liveAddress(target, st.vm.id, log) : null;
  const ip = live || (st.vm?.ipv4 || []).find((a) => !onlyLinkLocal([a])) || rows[0].vars?.network_static_ip;
  if (!ip) throw new Error(`Cible ${target.name} : adresse IP inconnue (agent invité de la VM sans IPv4 remontée)`);
  log?.write(`Cible ${target.name} : adresse ${ip}${live ? ' (lue dans XCP-ng)' : ' (état OpenTofu)'}\n`);
  return ip;
}

async function winrmCertificate(target, index, { work, files }) {
  if (!target.ca_certificate_id) return { vars: { ansible_winrm_server_cert_validation: 'ignore' }, note: 'certificat non vérifié' };
  const at = `Cible ${target.name}, vérification du certificat`;
  let ca;
  try {
    ca = await resolveCertificate(target.ca_certificate_id, ['ca']);
  } catch (e) {
    throw new Error(`${at} : ${e.message}`);
  }
  if (ca.expired) throw new Error(`${at} : autorité « ${ca.value.name} » expirée`);
  const caFile = path.join('keys', `ca${index + 1}.pem`);
  files.create(caFile, ca.value.fullchain);
  return {
    vars: { ansible_winrm_server_cert_validation: 'validate', ansible_winrm_ca_trust_path: path.join(work, caFile) },
    note: `certificat vérifié par l'autorité « ${ca.value.name} »`,
  };
}

async function hostEntry(target, index, { os, work, files, log }) {
  const address = await targetAddress(target, log);
  const entry = await resolveForJob(target.safe_entry_id, { passwordOnly: target.connection === 'winrms' });
  const vars = { ansible_host: address, ansible_port: target.port, ansible_user: entry.username };
  if (entry.type === 'password') {
    vars.ansible_password = entry.secret;
    log.addSecrets(entry.secret);
  } else {
    const keyFile = path.join('keys', `k${index + 1}`);
    files.create(keyFile, `${entry.secret.trim()}\n`);
    vars.ansible_ssh_private_key_file = path.join(work, keyFile);
    log.addSecrets(...keySecrets(entry.secret));
  }
  if (target.connection === 'ssh') {
    vars.ansible_connection = 'ssh';
    vars.ansible_control_path_dir = path.join(work, 'cp');
    vars.ansible_ssh_common_args = [`-o UserKnownHostsFile=${path.join(work, 'known_hosts')}`, '-o StrictHostKeyChecking=accept-new', '-o HashKnownHosts=no',
      ...(entry.type === 'ssh_key' ? ['-o IdentitiesOnly=yes'] : [])].join(' ');
    if (os === 'windows') vars.ansible_shell_type = 'cmd';
    else vars.ansible_python_interpreter = 'auto_silent';
  }
  let certificateNote = '';
  if (target.connection === 'winrms') {
    const certificate = await winrmCertificate(target, index, { work, files });
    Object.assign(vars, { ansible_connection: 'winrm', ansible_winrm_scheme: 'https', ansible_winrm_transport: 'ntlm', ...certificate.vars });
    certificateNote = `, ${certificate.note}`;
  }
  let sudo = '';
  if (target.become_entry_id) {
    const become = await resolveForJob(target.become_entry_id, { passwordOnly: true });
    vars.ansible_become_password = become.secret;
    log.addSecrets(become.secret);
    sudo = `, sudo avec le mot de passe de « ${become.name} »`;
  }
  log.write(`Cible ${target.name} : ${address}:${target.port} (${CONNECTION_LABELS[target.connection]}), compte « ${entry.username} »`
    + ` (${entry.type === 'password' ? 'mot de passe' : 'clé SSH'}, coffre-fort « ${entry.name} »)${sudo}${certificateNote}`
    + `${target.source === 'forge' ? ', VM déployée par Forge' : ''}\n`);
  return { name: target.name, vars, token: target.connection === 'ssh' ? knownHostToken(address, target.port) : null };
}

async function vaultValues(keys, log) {
  const vault = {};
  for (const [entryId, key] of keys) {
    const entry = await resolveForJob(entryId);
    log.addSecrets(...(entry.type === 'password' ? [entry.secret] : keySecrets(entry.secret)));
    vault[key] = entry.type === 'password'
      ? { username: entry.username, password: entry.secret }
      : { username: entry.username, private_key: `${entry.secret.trim()}\n`, public_key: entry.publicKey };
    log.write(`Paramètre d'étape : entrée du coffre-fort « ${entry.name} » (${entry.type === 'password' ? 'mot de passe' : 'clé SSH'})\n`);
  }
  return vault;
}

const CERT_LABELS = { cert_key: 'certificat + clé', pkcs12: 'PKCS12', ca: 'autorité de certification' };

async function certValues(keys, steps, log) {
  const allowed = new Map();
  steps.forEach(({ brick, values }) => brick.parameters.filter((p) => p.type === 'certificate_entry' && values[p.name])
    .forEach((p) => {
      const prev = allowed.get(values[p.name]);
      allowed.set(values[p.name], prev ? prev.filter((t) => p.cert_types.includes(t)) : p.cert_types);
    }));
  const certs = {};
  for (const [entryId, key] of keys) {
    const { value, secrets, expired } = await resolveCertificate(entryId, allowed.get(entryId));
    if (value.private_key) log.addSecrets(...keySecrets(value.private_key));
    log.addSecrets(...secrets);
    certs[key] = value;
    const day = new Date(value.not_after).toLocaleDateString('fr-FR');
    log.write(`Paramètre d'étape : certificat « ${value.name} » (${CERT_LABELS[value.type]}), ${expired ? `EXPIRÉ depuis le ${day}` : `valide jusqu'au ${day}`}\n`);
    if (expired) log.write(`Attention : le certificat « ${value.name} » est expiré, il est déployé quand même\n`);
  }
  return certs;
}

async function buildPlaybook(job, log) {
  const vars = job.vars_snapshot;
  const os = vars.os_type;
  if (job.action === 'ping') return { playbook: pingPlaybook(os, os === 'linux'), vault: {}, certs: {}, bricks: [] };
  if (vars.config_type === 'yaml') return { playbook: vars.playbook, vault: {}, certs: {}, bricks: [] };
  const steps = (vars.steps || []).map((s, i) => ({ ...s, at: `Étape ${i + 1}` })).filter((s) => s.enabled)
    .map((s) => {
      const brick = resolveStepBrick(s, os, s.at);
      return { brick, values: checkStepValues(brick, s.values, `${s.at} (${brick.name})`) };
    });
  const skipped = (vars.steps || []).length - steps.length;
  log.write(`Étapes : ${steps.length} active(s)${skipped ? `, ${skipped} désactivée(s)` : ''}${steps.length ? ` : ${steps.map((s) => s.brick.name).join(', ')}` : ''}\n`);
  const keys = vaultKeys(steps);
  const vault = await vaultValues(keys, log);
  const certKeyMap = certKeys(steps);
  const certs = await certValues(certKeyMap, steps, log);
  const bricks = [...new Map(steps.map((s) => [s.brick.id, s.brick])).values()];
  return { playbook: guidedPlaybook({ name: vars.profile, os, steps, keys, certs: certKeyMap }), vault, certs, bricks };
}

async function knownHostLines(tokens) {
  if (!tokens.length) return '';
  const { rows } = await pool.query('SELECT keys FROM ansible_known_hosts WHERE host = ANY($1)', [tokens]);
  return rows.map((r) => r.keys.trim()).filter(Boolean).join('\n');
}

async function learnHostKeys(hosts, files, log) {
  const text = files.readText('known_hosts', KNOWN_HOSTS_MAX);
  if (text === null) return;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const { name, token } of hosts.filter((x) => x.token)) {
    const own = lines.filter((l) => l.split(/\s+/)[0].split(',').includes(token));
    if (!own.length) continue;
    const { rowCount } = await pool.query(
      'INSERT INTO ansible_known_hosts (host, keys) VALUES ($1, $2) ON CONFLICT (host) DO NOTHING', [token, own.join('\n')]);
    if (rowCount) log.write(`Empreinte SSH enregistrée pour ${name} (${token}) : elle sera exigée aux prochaines connexions\n`);
  }
}

function readEvent(files, rel) {
  try {
    return JSON.parse(files.readText(rel, EVENT_MAX));
  } catch {
    return null;
  }
}

function readRecap(files, hosts) {
  const dir = path.join('artifacts', IDENT, 'job_events');
  let stats = null;
  for (const name of files.list(dir).sort()) {
    const event = readEvent(files, path.join(dir, name));
    if (event?.event === 'playbook_on_stats') stats = event.event_data;
  }
  if (!stats) return null;
  const count = (key, host) => Number(stats[key]?.[host] || 0);
  return Object.fromEntries(hosts.map(({ name }) => [name, [
    `ok ${count('ok', name)}`, `modifié ${count('changed', name)}`, `échec ${count('failures', name)}`,
    `injoignable ${count('dark', name)}`, `ignoré ${count('skipped', name)}`,
  ].join(', ')]));
}

function writeWork(files, contents) {
  for (const sub of ['project', 'inventory', 'env']) files.mkdir(sub);
  for (const [name, content] of contents) files.create(name, content);
}

function readResult(files) {
  const text = files.readText('result.json', RESULT_MAX);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Résultat de forge-ansible illisible (result.json)');
  }
}

async function waitForRunner(files, { log, state }) {
  const stdout = path.join('artifacts', IDENT, 'stdout');
  const decoder = new StringDecoder('utf8');
  const since = Date.now();
  let offset = 0;
  let cancelSent = false;
  let text = '';
  const drain = () => {
    for (;;) {
      const bytes = files.readChunk(stdout, offset, STDOUT_CHUNK);
      if (!bytes.length) return;
      offset += bytes.length;
      const chunk = decoder.write(bytes);
      text += chunk;
      log.write(chunk);
      if (bytes.length < STDOUT_CHUNK) return;
    }
  };
  for (;;) {
    drain();
    if (files.present('result.json')) {
      drain();
      log.write(`${decoder.end()}\n`);
      return { ...readResult(files), text };
    }
    if (!files.present('started')) {
      if (state.cancelled || Date.now() - since > PICKUP_TIMEOUT_MS) {
        files.remove('ready');
        if (!files.present('started')) {
          if (state.cancelled) return { rc: 1, status: 'canceled', text };
          throw new Error(`Conteneur forge-ansible indisponible : job non pris en charge en ${PICKUP_TIMEOUT_MS / 1000} s (vérifier « docker compose ps »)`);
        }
      }
    } else if (state.cancelled && !cancelSent) {
      files.signal('cancel');
      cancelSent = true;
      log.write('\nAnnulation demandée : arrêt d\'Ansible…\n');
    }
    await sleep(POLL_MS);
  }
}

async function executeJob(job, { dir, work, files, log, state }) {
  const vars = job.vars_snapshot;
  const os = vars.os_type;
  const targets = vars.targets || [];
  log.write(`Job ${job.id} : ansible, ${ACTION_LABELS[job.action]} — profil « ${vars.profile} »\n`);
  log.write(`${os === 'windows' ? 'Windows' : 'Linux'}, ${vars.config_type === 'yaml' ? 'playbook YAML' : 'étapes guidées'}, `
    + `${targets.length} cible(s), ${vars.forks} en parallèle, délai maximal ${Number(vars.timeout_min) ? `${vars.timeout_min} min` : 'aucun'}\n`);
  if (!targets.length) throw new Error('Aucune cible : ajouter au moins un serveur dans l\'onglet Cibles du profil');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { mode: 0o700 });
  files.mkdir('keys');
  const hosts = [];
  for (const [i, target] of targets.entries()) hosts.push(await hostEntry(target, i, { os, work, files, log }));
  const { playbook, vault, certs, bricks } = await buildPlaybook(job, log);
  const inventory = inventoryText({ hosts, vault, certs });
  const settings = { suppress_ansible_output: false, ...(Number(vars.timeout_min) ? { job_timeout: Number(vars.timeout_min) * 60 } : {}) };
  const cmdline = [`--forks ${Number(vars.forks) || 1}`, ...(job.action === 'check' ? ['--check', '--diff'] : [])].join(' ');
  const knownHosts = await knownHostLines(hosts.map((x) => x.token).filter(Boolean));
  writeWork(files, [
    ['project/playbook.yml', playbook],
    ['inventory/hosts.yml', inventory],
    ['env/settings', JSON.stringify(settings)],
    ['env/cmdline', cmdline],
    ['env/envvars', JSON.stringify({ ANSIBLE_HOST_KEY_CHECKING: 'True', ...(log.colors ? { ANSIBLE_FORCE_COLOR: 'True' } : {}) })],
    ['known_hosts', knownHosts ? `${knownHosts}\n` : ''],
  ]);
  saveFiles(dir, [
    ['playbook.yml', playbook],
    ['inventory.yml', archivedInventory({ hosts, vault, certs })],
    ...bricks.map((b) => [`catalogue/${b.id.replace(':', '/')}.yml`, b.yaml]),
  ], log.mask);
  if (state.cancelled) throw new Error('Job annulé avant l\'exécution d\'Ansible');
  log.write(`\nAnsible : ${cmdline}\n\n`);
  files.create('.ready.tmp', '');
  fs.renameSync(path.join(work, '.ready.tmp'), path.join(work, 'ready'));
  const outcome = await waitForRunner(files, { log, state });
  if (outcome.error) log.write(`Erreur : ${outcome.error}\n`);
  if (outcome.status === 'timeout') log.write(`Délai maximal de ${vars.timeout_min} min dépassé : Ansible arrêté\n`);
  if (HOST_KEY_CHANGED.test(stripAnsi(outcome.text))) {
    log.write('Attention : empreinte SSH différente de celle enregistrée. Vérifier le serveur ; si sa réinstallation est volontaire, '
      + 'utiliser « Réinitialiser les empreintes » sur le profil\n');
  }
  await learnHostKeys(hosts, files, log);
  const recap = readRecap(files, hosts);
  if (recap) {
    log.write(`\nRécapitulatif :\n${Object.entries(recap).map(([h, line]) => `  ${h} : ${line}`).join('\n')}\n`);
    await pool.query('UPDATE ansible_jobs SET recap = $2 WHERE id = $1', [job.id, recap])
      .catch((e) => console.error(`ansible_jobs ${job.id} : récapitulatif non enregistré :`, e.message));
  }
  return outcome.status === 'successful' ? 0 : Number(outcome.rc) || 1;
}

function openJob(job) {
  const work = workDir(job.id);
  return { work, files: workFiles(work) };
}

function closeJob(job) {
  fs.rmSync(workDir(job.id), { recursive: true, force: true });
}
