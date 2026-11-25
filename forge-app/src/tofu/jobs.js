import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, pool } from '../db.js';
import { sha512Crypt } from '../crypto.js';
import { childEnv, createJobQueue, runCommand } from '../runner.js';
import { resolveForJob, windowsPasswordProblem } from '../safe.js';
import { preflight } from './preflight.js';
import { removeWindowsConfigDrive } from './configdrive.js';
import { applyVmSettings, blockedOperations, onlyLinkLocal, waitRoutableIp } from './vmsettings.js';
import { forgetState, stateSchema, tofuStateSummary } from './state.js';
import { getResourceSet, listXoSubjects, xoCreds, xoProviderEnv } from './xo.js';
import { buildNetworkConfig, buildUserData, buildWindowsUserData, fieldsIgnoredByCustom, profileMac } from './cloudinit.js';
import { saveFiles } from '../archive.js';

const MODULE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module');
const CLI_CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tofurc');
const PROVIDER_LOCK_FILE = '/opt/tofu-lock/.terraform.lock.hcl';

const CANCEL_GRACE_MS = 120000;

export const tofuJobDir = (id) => path.join(DATA_DIR, 'jobs-tofu', id);
const TOFU_WORK = path.join(DATA_DIR, 'work', 'tofu');
const tofuWork = (id) => path.join(TOFU_WORK, id);

function pgConnString() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

const queue = createJobQueue({
  table: 'tofu_jobs', profiles: 'tofu_profiles',
  stamps: { plan: 'planned_at', apply: 'applied_at', import: 'applied_at', destroy: 'destroyed_at' },
  jobDir: tofuJobDir, open: openJob, execute: executeJob, close: closeJob, cancelGraceMs: CANCEL_GRACE_MS,
});
export const { pump: tofuPump, cancel: cancelTofu } = queue;
export async function recoverOrphanTofuJobs() {
  await queue.recoverOrphans((id) => fs.rmSync(tofuWork(id), { recursive: true, force: true }));
  fs.rmSync(TOFU_WORK, { recursive: true, force: true });
}

export async function enqueueTofu(profile, action) {
  const { rows } = await pool.query(
    `INSERT INTO tofu_jobs (profile_id, action, vars_snapshot) VALUES ($1, $2, $3) RETURNING *`,
    [profile.id, action, { ...profile.vars, profile: profile.name }],
  );
  tofuPump();
  return rows[0];
}

async function checkAclSubjects(acls, log) {
  const subjects = new Map((await listXoSubjects()).map((s) => [s.id, s]));
  const missing = acls.filter((a) => !subjects.has(a.subject));
  if (missing.length) throw new Error(`ACL : sujet(s) introuvable(s) dans Xen Orchestra : ${missing.map((a) => a.subject).join(', ')}`);
  log.write(`ACL : ${acls.map((a) => `${subjects.get(a.subject).name} (${a.role})`).join(', ')}\n`);
}

async function resolveAccess(vars, { firstDeploy }) {
  const entry = await resolveForJob(vars.safe_entry_id);
  if (firstDeploy && vars.os_type === 'windows' && entry.type === 'password') {
    const problem = windowsPasswordProblem(entry.secret, entry.username);
    if (problem) throw new Error(`Entrée « ${entry.name} » : mot de passe refusé par Windows (${problem}), le compte ne serait pas créé. Changer le mot de passe de l'entrée ou en choisir une autre`);
  }
  return entry.type === 'password'
    ? { user: entry.username, password: entry.secret, publicKeys: [], safeName: entry.name }
    : { user: entry.username, password: '', publicKeys: [entry.publicKey], safeName: entry.name };
}

async function moduleValues(vars, { poolId, mac, extraNetworks, resourceSetTags = [], log, withConfig = true, firstDeploy = false }) {
  const linux = vars.os_type !== 'windows';
  const tfvars = {
    pool_id: poolId,
    template: vars.source_template,
    sr_id: vars.sr_uuid,
    network: vars.network,
    vm_name: vars.vm_name,
    vm_description: vars.vm_description || '',
    cpus: Number(vars.vcpus),
    cores_per_socket: Number(vars.cores_per_socket) || 1,
    memory_mb: Number(vars.vm_memory),
    disk_gb: Number(vars.disk_size),
    disk_name: vars.disk_name || `${vars.vm_name}-disk0`,
    affinity_host: vars.affinity_host || '',
    auto_poweron: vars.auto_poweron !== 'false',
    blocked_operations: blockedOperations(vars),
    high_availability: vars.high_availability || '',
    hvm_boot_firmware: vars.boot_firmware || 'bios',
    secure_boot: vars.boot_firmware === 'uefi' && vars.secure_boot === 'true',
    vga: vars.vga === 'false' ? 'cirrus' : 'std',
    videoram: Number(vars.videoram || 8),
    resource_set: vars.resource_set || '',
    resource_set_share: String(vars.resource_set_share) === 'true',
    acls: vars.acls || [],
    extra_disks: (vars.extra_disks || []).map(({ name, sr_uuid, size_gb }) => ({ name, sr_id: sr_uuid, size_gb })),
    destroy_cloud_config: linux && String(vars.destroy_cloud_config) === 'true',
    clone_type: vars.clone_type === 'fast' ? 'fast' : 'full',
    tags: String(vars.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    resource_set_tags: resourceSetTags,
    mac_address: mac,
    extra_networks: extraNetworks.map(({ network, mac: m }) => ({ network, mac: m })),
    cloud_config: null,
    cloud_network_config: null,
    expected_ip_cidr: String(vars.wait_for_ip) === 'false' ? ''
      : vars.network_static_ip ? `${vars.network_static_ip}/32` : '0.0.0.0/0',
  };
  if (!withConfig) return { ...tfvars, destroy_mode: true, extra_disks: [], extra_networks: [] };
  const access = vars.cloud_init_yaml ? null : await resolveAccess(vars, { firstDeploy });
  if (access) {
    if (access.password) log.addSecrets(access.password);
    log.write(`Compte d'administration : « ${access.user} »`
      + `${access.password ? ', mot de passe' : ''}${access.publicKeys.length ? `, ${access.publicKeys.length} clé(s) SSH` : ''}`
      + ` (coffre-fort « ${access.safeName} »)\n`);
  } else {
    log.write('Comptes et accès : définis par le user-data personnalisé (entrée du coffre-fort du profil non utilisée)\n');
    const ignored = fieldsIgnoredByCustom(vars);
    if (ignored.length) log.write(`Attention, champs du profil ignorés à cause du user-data personnalisé : ${ignored.join(', ')}\n`);
  }
  const { user = '', password = '', publicKeys = [] } = access || {};
  if (linux) {
    let passwordHash = '';
    if (password) {
      passwordHash = await sha512Crypt(password);
      log.addSecrets(passwordHash);
    }
    tfvars.cloud_config = buildUserData({ vars, user, passwordHash, publicKeys });
    tfvars.cloud_network_config = buildNetworkConfig({ vars, mac, extra: extraNetworks });
  } else {
    if (password) log.addSecrets(JSON.stringify(password).slice(1, -1));
    tfvars.cloud_config = buildWindowsUserData({ vars, user, password, publicKeys });
    tfvars.cloud_network_config = buildNetworkConfig({ vars, mac, extra: extraNetworks, dhcpType: 'dhcp' });
  }
  return tfvars;
}

const PLAN_FILE = 'tfplan';
const STATE_FILE = 'state.json';
const PLAN_HAS_CHANGES = 2;
const USER_DATA_REMOVED = '#retiré de l\'état';
const DEBUG_LOG = 'tofu-debug.log';
const ACTION_LABELS = { create: 'création', update: 'modification', delete: 'suppression', replace: 'recréation' };

async function planSummary(opts) {
  const res = await runCommand('tofu', ['show', '-json', '-no-color', PLAN_FILE], { ...opts, capture: true });
  if (res.code !== 0) return { code: res.code, summary: '' };
  const plan = JSON.parse(res.stdout);
  const counts = {};
  for (const rc of plan.resource_changes || []) {
    const action = rc.change.actions.length === 2 ? 'replace' : rc.change.actions[0];
    if (ACTION_LABELS[action]) counts[action] = (counts[action] || 0) + 1;
  }
  if (!Object.keys(counts).length) {
    return { code: 0, summary: 'Aucun changement de l\'infrastructure : seules les sorties ont évolué depuis le dernier déploiement (ex. adresse IP remontée par l\'agent invité)' };
  }
  const detail = Object.entries(counts).map(([a, n]) => `${n} ${ACTION_LABELS[a]}${n > 1 ? 's' : ''}`).join(', ');
  return { code: 0, summary: `Changements prévus (${detail}) : lancer « Construire » pour les appliquer` };
}

async function resourceSetTagsFor(vars, ownVmId, log) {
  const { tags } = await getResourceSet(vars.resource_set);
  log.write(`Groupe self-service « ${vars.resource_set} »${tags.length ? ` : tags du groupe ${tags.join(', ')}` : ''}\n`);
  return ownVmId ? tags : [];
}

async function buildModuleValues(job, profile, log, state) {
  const vars = job.vars_snapshot;
  const destroying = job.action === 'destroy';
  const importing = job.action === 'import';
  const stateVmId = (await tofuStateSummary(profile.id, { fresh: true }))?.vm?.id || null;
  if (importing && stateVmId) throw new Error(`VM ${stateVmId} déjà gérée par l'état du profil : rien à importer`);
  if (importing && !vars.vm_uuid) throw new Error('Import réservé aux profils créés par « Importer une VM »');
  const ownVmId = importing ? vars.vm_uuid : stateVmId;
  const mac = vars.vm_mac || profileMac(profile.id);
  const { poolId, memoryFrom } = await preflight(vars, log,
    { full: !destroying, ownVmId, mac, waitGuest: job.action === 'apply', repair: job.action === 'apply', state });
  if (memoryFrom !== undefined) {
    log.write(`Mémoire ${memoryFrom} → ${vars.vm_memory} Mo : le provider arrête la VM, applique la mémoire et la redémarre${job.action === 'apply' ? '' : ' (au prochain apply)'}\n`);
  }
  if (vars.acls?.length && !destroying) await checkAclSubjects(vars.acls, log);
  const resourceSetTags = vars.resource_set && !destroying ? await resourceSetTagsFor(vars, ownVmId, log) : [];
  const extraNetworks = (vars.extra_networks || []).map((n, i) => ({ ...n, mac: profileMac(profile.id, i + 1) }));
  const tfvars = await moduleValues(vars, {
    poolId, mac, extraNetworks, resourceSetTags, log, withConfig: !destroying, firstDeploy: !ownVmId,
  });
  return { tfvars, importVmId: importing ? ownVmId : null };
}

const moduleSource = () => fs.readFileSync(path.join(MODULE_DIR, 'main.tf'), 'utf8');

function prepareWorkDir(workDir, tfvars) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workDir, 'main.tf'), moduleSource());
  if (fs.existsSync(PROVIDER_LOCK_FILE)) fs.copyFileSync(PROVIDER_LOCK_FILE, path.join(workDir, '.terraform.lock.hcl'));
  fs.writeFileSync(path.join(workDir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), { mode: 0o600 });
}

function saveJobFiles(dir, tfvars, log) {
  saveFiles(dir, [
    ['main.tf', moduleSource()],
    ['terraform.tfvars.json', JSON.stringify({
      ...tfvars,
      cloud_config: tfvars.cloud_config && '(fichier user-data)',
      cloud_network_config: tfvars.cloud_network_config && '(fichier network-config)',
    }, null, 2)],
    ...(tfvars.cloud_config ? [['user-data', tfvars.cloud_config]] : []),
    ...(tfvars.cloud_network_config ? [['network-config', tfvars.cloud_network_config]] : []),
  ], log.mask);
}

const noColor = (opts) => (opts.log.colors ? [] : ['-no-color']);

async function runPlan(opts) {
  const common = ['-input=false', ...noColor(opts), '-lock-timeout=120s'];
  const { code } = await runCommand('tofu', ['plan', ...common, '-detailed-exitcode', `-out=${PLAN_FILE}`], opts);
  if (code === PLAN_HAS_CHANGES) return planSummary(opts);
  return { code, summary: code === 0 ? 'Aucun changement : l\'infrastructure est conforme au profil' : '' };
}

async function readOutputs(opts) {
  const { code, stdout } = await runCommand('tofu', ['output', '-json', '-no-color'], { ...opts, capture: true });
  if (code !== 0) return { outputs: null, summary: '' };
  const outputs = Object.fromEntries(Object.entries(JSON.parse(stdout || '{}')).map(([k, v]) => [k, v.value]));
  opts.log.write(`${JSON.stringify(outputs, null, 2)}\n`);
  const ips = (outputs.ipv4_addresses || []).join(', ');
  return { outputs, summary: `VM « ${outputs.vm_name} » déployée${ips ? ` — IPv4 : ${ips}` : ''}` };
}

const userDataInState = (attributes) => (attributes.destroy_cloud_config_vdi_after_boot ? USER_DATA_REMOVED : null);

async function pushStateWithoutUserData(opts) {
  const pulled = await runCommand('tofu', ['state', 'pull'], { ...opts, capture: true });
  if (pulled.code !== 0) throw new Error(`lecture de l'état, code ${pulled.code}`);
  if (!pulled.stdout.trim()) return;
  const tfstate = JSON.parse(pulled.stdout);
  const filled = (tfstate.resources || [])
    .filter((r) => r.mode === 'managed' && r.type === 'xenorchestra_vm')
    .flatMap((r) => r.instances || [])
    .filter((i) => i.attributes && (i.attributes.cloud_config ?? null) !== userDataInState(i.attributes));
  if (!filled.length) return;
  for (const instance of filled) instance.attributes.cloud_config = userDataInState(instance.attributes);
  tfstate.serial += 1;
  fs.writeFileSync(path.join(opts.cwd, STATE_FILE), JSON.stringify(tfstate), { mode: 0o600 });
  const pushed = await runCommand('tofu', ['state', 'push', '-lock-timeout=120s', STATE_FILE], opts);
  if (pushed.code !== 0) throw new Error(`écriture de l'état, code ${pushed.code}`);
  opts.log.write('User-data retiré de l\'état OpenTofu\n');
}

async function removeUserDataFromState(opts) {
  try {
    await pushStateWithoutUserData(opts);
  } catch (e) {
    opts.log.write(`Attention, user-data non retiré de l'état OpenTofu (${e.message}), nouvel essai au prochain job\n`);
  }
}

async function runTofuAction(job, opts, profileId) {
  const { state } = opts;
  const init = await runCommand('tofu',
    ['init', '-input=false', ...noColor(opts), `-backend-config=schema_name=${stateSchema(profileId)}`], opts);
  if (init.code !== 0 || state.cancelled) return { code: init.code };
  if (job.action === 'plan') {
    const planned = await runPlan(opts);
    await removeUserDataFromState(opts);
    return planned;
  }

  if (job.action === 'import') return importVm(job, opts);

  const { code } = await runCommand('tofu', [job.action, '-input=false', ...noColor(opts), '-lock-timeout=120s', '-auto-approve'], opts);
  if (job.action === 'apply') await removeUserDataFromState(opts);
  if (code !== 0 || job.action === 'destroy' || state.cancelled) return { code };
  return afterDeploy(job, { code, ...(await readOutputs(opts)) }, opts);
}

async function importVm(job, opts) {
  const { log, state, importVmId } = opts;
  const common = ['-input=false', ...noColor(opts), '-lock-timeout=120s'];
  const imported = await runCommand('tofu', ['import', ...common, 'xenorchestra_vm.this', importVmId], opts);
  await removeUserDataFromState(opts);
  if (imported.code !== 0 || state.cancelled) return { code: imported.code };
  log.write('VM importée dans l\'état OpenTofu : lecture de ses sorties (refresh-only, VM inchangée)\n');
  const { code } = await runCommand('tofu', ['apply', ...common, '-refresh-only', '-auto-approve'], opts);
  await removeUserDataFromState(opts);
  if (code !== 0 || state.cancelled) return { code };
  const result = await afterDeploy(job, { code, ...(await readOutputs(opts)) }, opts);
  if (result.code !== 0 || !result.outputs) return result;
  return { ...result, summary: `VM « ${result.outputs.vm_name} » importée dans le profil — lancer « Valider » pour voir les écarts avec le profil` };
}

async function afterDeploy(job, result, opts) {
  const vars = job.vars_snapshot;
  const vmId = result.outputs?.vm_id;
  if (!vmId) return result;
  if (vars.os_type === 'windows' && String(vars.destroy_cloud_config) === 'true') {
    if (!await removeWindowsConfigDrive(vmId, opts)) return { ...result, code: 1 };
  }
  try {
    await applyVmSettings(vmId, vars, opts);
  } catch (e) {
    opts.log.write(`Erreur, réglages Xen : ${e.message}\n`);
    return { ...result, code: 1 };
  }
  if (vars.wait_for_ip === 'false') return result;
  if (onlyLinkLocal(result.outputs.ipv4_addresses)) {
    opts.log.write(`Adresse automatique ${result.outputs.ipv4_addresses.join(', ')} (APIPA, DHCP pas encore répondu) : attente de l'adresse réelle\n`);
    return refreshStateIp(vmId, result, opts);
  }
  const stateIps = (await tofuStateSummary(job.profile_id, { fresh: true }))?.vm?.ipv4 || [];
  if (stateIps.length && !onlyLinkLocal(stateIps)) return result;
  opts.log.write('Adresse IP absente de l\'état OpenTofu (VM relue pendant son redémarrage) : attente de l\'adresse réelle\n');
  return refreshStateIp(vmId, result, opts);
}

async function refreshStateIp(vmId, result, opts) {
  const { log } = opts;
  const ip = await waitRoutableIp(vmId, opts).catch((e) => { log.write(`Lecture de l'adresse impossible : ${e.message}\n`); return null; });
  if (!ip) {
    log.write('Attention : aucune adresse réelle remontée en 5 min, état OpenTofu non mis à jour. Relancer « Appliquer » une fois la VM sur le réseau\n');
    return result;
  }
  log.write(`Adresse réelle ${ip} : mise à jour de l'état OpenTofu (refresh-only, VM inchangée)\n`);
  const { code } = await runCommand('tofu', ['apply', '-input=false', ...noColor(opts), '-lock-timeout=120s', '-refresh-only', '-auto-approve'], opts);
  await removeUserDataFromState(opts);
  if (code !== 0) {
    log.write(`Attention : mise à jour de l'état en échec (code ${code})\n`);
    return result;
  }
  return { code: result.code, ...(await readOutputs(opts)) };
}

async function loadProfile(job) {
  const { rows } = await pool.query('SELECT id FROM tofu_profiles WHERE id = $1', [job.profile_id]);
  if (!rows[0]) throw new Error('Profil OpenTofu supprimé');
  return rows[0];
}

async function executeJob(job, { dir, work, workDir, log, state }) {
  const profile = await loadProfile(job);
  const vars = job.vars_snapshot;
  log.write(`Job ${job.id} : tofu ${job.action} — profil « ${vars.profile} »\n`);
  log.write(`VM « ${vars.vm_name} » depuis le template « ${vars.source_template} » (${vars.os_type === 'windows' ? 'Windows, cloudbase-init' : 'Linux, cloud-init'})\n`);

  const xo = await xoCreds();
  const pgConn = pgConnString();
  log.addSecrets(xo.pass, decodeURIComponent(new URL(pgConn).password));
  log.write(`Xen Orchestra : ${xo.host}${xo.insecure ? ' (certificat non vérifié)' : xo.caName ? ` (certificat vérifié par l'autorité « ${xo.caName} »)` : ''}\n`);
  const caFile = xo.ca ? path.join(dir, 'xo-ca.pem') : null;
  if (caFile) fs.writeFileSync(caFile, xo.ca, { mode: 0o644 });

  const { tfvars, importVmId } = await buildModuleValues(job, profile, log, state);
  prepareWorkDir(workDir, tfvars);
  saveJobFiles(dir, tfvars, log);

  const env = childEnv({
    ...xoProviderEnv(xo, caFile),
    PG_CONN_STR: pgConn,
    TF_CLI_CONFIG_FILE: CLI_CONFIG_FILE,
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    TF_LOG: 'INFO',
    TF_LOG_PATH: path.join(work, DEBUG_LOG),
    CHECKPOINT_DISABLE: '1',
  });
  if (state.cancelled) throw new Error("Job annulé avant l'exécution d'OpenTofu");
  const { code, summary } = await runTofuAction(job, { env, cwd: workDir, log, state, importVmId }, profile.id);
  if (summary && code === 0 && !state.cancelled) log.write(`\n${summary}\n`);
  return code;
}

function openJob(job) {
  const work = tofuWork(job.id);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  return { work, workDir: path.join(work, 'work') };
}

function closeJob(job, { dir, log }, status) {
  const work = tofuWork(job.id);
  if (status !== 'success' && log) log.maskFile(path.join(work, DEBUG_LOG), path.join(dir, DEBUG_LOG));
  fs.rmSync(work, { recursive: true, force: true });
  if (job.profile_id) forgetState(job.profile_id);
}
