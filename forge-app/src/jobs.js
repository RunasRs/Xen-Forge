import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_DIR, pool } from './db.js';
import { sha512Crypt } from './crypto.js';
import { childEnv, createJobQueue, runCommand, stripAnsi } from './runner.js';
import { resolveForJob, resolveProductKey } from './safe.js';
import { toPkrvars, withBuildDefaults } from './variables.js';
import { srFinder, withMaster } from './xcp.js';
import { EL_FAMILIES, normalizeVars } from './os.js';
import { prepareRecipe, usesBuildHttp } from './answerfiles/index.js';
import { jobCommandTrace } from './commandtrace.js';
import { LOCKED_PASSWORD, cidrToNetmask, hostnameOf, xkbLayout, xmlEscape } from './answerfiles/common.js';
import { readTree, saveFiles } from './archive.js';
import { audit } from './audit.js';
import { EXISTING_TEMPLATE, diskLabel, listTemplates, replaceTemplates } from './xcptemplates.js';

const PACKER_DIR = process.env.PACKER_DIR || '/packer';
const HTTP_PORT = Number(process.env.BUILD_HTTP_PORT || 8080);
const XCP_SETTINGS = ['remote_host', 'remote_username', 'remote_password'];

export const jobDir = (id) => path.join(DATA_DIR, 'jobs-packer', id);
const PACKER_WORK = path.join(DATA_DIR, 'work', 'packer');
const packerWork = (id) => path.join(PACKER_WORK, id);
const DEBUG_LOG = 'packer-debug.log';

const queue = createJobQueue({
  table: 'jobs', profiles: 'profiles', stamps: { build: 'built_at', validate: 'validated_at' },
  jobDir, open: openJob, execute: executeJob, close: closeJob, cancelGraceMs: 20000,
});
export const { pump, cancel } = queue;
const BUILD_CD_NAME = 'Packer-CD';
const R15_ERROR = /Error establishing VNC session: error parsing ProtocolVersion/;
const R15_MAX_RETRIES = 3;
const R15_PAUSE_MS = 30_000;
async function pauseUnlessCancelled(ms, state) {
  for (let left = ms; left > 0 && !state.cancelled; left -= 1000) {
    await sleep(Math.min(1000, left));
  }
}
export async function recoverOrphans() {
  await queue.recoverOrphans(removeSecretArtifacts);
  fs.rmSync(PACKER_WORK, { recursive: true, force: true });
}

const replacing = (mode) => mode === EXISTING_TEMPLATE.replace || mode === EXISTING_TEMPLATE.replacePurge;

export async function enqueue(profile, action, launcher = null) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (profile_id, action, vars_snapshot)
     VALUES ($1, $2, $3) RETURNING *`,
    [profile.id, action, { ...profile.vars, profile: profile.name, ...(launcher?.user ? { launched_by: launcher.user, launched_from: launcher.ip || null } : {}) }],
  );
  pump();
  return rows[0];
}

function removeSecretArtifacts(id) {
  fs.rmSync(packerWork(id), { recursive: true, force: true });
}

let declared = null;
function declaredVariables() {
  declared ||= new Set([...fs.readFileSync(path.join(PACKER_DIR, 'variables.pkr.hcl'), 'utf8')
    .matchAll(/^variable\s+"(\w+)"/gm)].map((m) => m[1]));
  return declared;
}

function pkrVarValues(vars, creds) {
  const hostname = hostnameOf(vars);
  const all = {
    ...vars,
    ...(usesBuildHttp(vars.os_family) ? { http_port: HTTP_PORT } : {}),
    network_netmask: vars.network_mode === 'static' ? cidrToNetmask(vars.network_cidr) : '',
    hostname,
    disk_name: String(vars.disk_name || '').trim() || `disk-${hostname}`,
    xkb_keymap: xkbLayout(vars.keyboard_layout || 'us'),
    ssh_username: creds.username,
    ssh_password: creds.sshPassword,
    ssh_private_key_file: creds.privateKeyFile,
    template_profile: vars.profile || '',
  };
  const names = declaredVariables();
  return Object.fromEntries(Object.entries(all)
    .filter(([k, v]) => names.has(k) && !XCP_SETTINGS.includes(k) && v !== undefined && v !== null));
}

function addPasswordSecret(log, password) {
  log.addSecrets(password, password && xmlEscape(password));
}

async function buildCredentials(rawVars, family, dir, log) {
  const entry = await resolveForJob(rawVars.safe_entry_id, { passwordOnly: family === 'windows' });
  if (entry.type === 'password') {
    addPasswordSecret(log, entry.secret);
    log.write(`Coffre-fort : « ${entry.name} » — compte « ${entry.username} »\n`);
    return { safeName: entry.name, sshPassword: entry.secret, username: entry.username, publicKey: '', privateKeyFile: '' };
  }
  const privateKeyFile = path.join(dir, 'id_rsa');
  fs.writeFileSync(privateKeyFile, entry.secret.endsWith('\n') ? entry.secret : `${entry.secret}\n`, { mode: 0o600 });
  log.addSecrets(entry.secret);
  log.write(`Coffre-fort : « ${entry.name} » — compte « ${entry.username} », clé SSH\n`);
  return { safeName: entry.name, sshPassword: null, username: entry.username, publicKey: entry.publicKey, privateKeyFile };
}

function checkTemplate(vars) {
  return withMaster(async (call) => {
    const vms = await call('VM.get_all_records');
    const tpl = Object.values(vms).find((v) => v.is_a_template && v.name_label === vars.clone_template);
    if (!tpl) throw new Error(`Template « ${vars.clone_template} » introuvable sur XCP-ng`);
    if (Number(tpl.VCPUs_at_startup) > Number(vars.vcpus)) {
      throw new Error(`vCPU du profil (${vars.vcpus}) inférieur au démarrage du template « ${vars.clone_template} » (${tpl.VCPUs_at_startup})`);
    }
    return tpl;
  });
}

function packerSrNames(vars, log) {
  return withMaster(async (call) => {
    const find = srFinder(await call('SR.get_all_records'));
    const nameOf = (uuid, label) => {
      const sr = find(uuid, label);
      const same = find.sameName(sr);
      if (same > 1) {
        throw new Error(`${label} : ${same} SR s'appellent « ${sr.name_label} » et le plugin Packer ne désigne un SR que par son nom. `
          + 'Donner un nom unique à ce SR dans Xen Orchestra');
      }
      log.write(`${label} : « ${sr.name_label} » (${sr.uuid})\n`);
      return sr.name_label;
    };
    return { sr_name: nameOf(vars.sr_uuid, 'SR du disque'), sr_iso_name: nameOf(vars.sr_iso_uuid, 'SR ISO') };
  });
}

function buildPlatform(vars, template) {
  const uefi = vars.firmware === 'uefi';
  const set = {
    secureboot: uefi && vars.secure_boot === 'true' ? 'true' : 'false',
    ...(vars.os_type === 'windows' ? { viridian: 'true' } : {}),
    ...(vars.cores_per_socket ? { 'cores-per-socket': String(vars.cores_per_socket) } : {}),
    ...(vars.nic_type === 'e1000' ? { nic_type: 'e1000' } : {}),
    ...(vars.vga === 'true' ? { vga: 'std', videoram: String(vars.videoram || 8) } : {}),
  };
  const removed = [
    ...(uefi ? ['device-model'] : []),
    ...(vars.nic_type === 'rtl8139' ? ['nic_type'] : []),
    ...(vars.vga === 'false' ? ['vga', 'videoram'] : []),
  ];
  const source = template.platform || {};
  if (!uefi && !('secureboot' in source)) delete set.secureboot;
  if (!Object.keys(set).length && !removed.some((key) => key in source)) return {};
  const platform = Object.fromEntries(Object.entries(source).filter(([key]) => !removed.includes(key)));
  return { platform_args: { ...platform, ...set } };
}

function xenExtras(vars) {
  return {
    vm_tags: String(vars.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    vm_other_config: { auto_poweron: 'true' },
  };
}

const hclValue = (recipe, key) => recipe.match(new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1] ?? null;
const hclList = (recipe, key) => {
  const m = recipe.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  return m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : null;
};

async function saveSnapshots(job, { vars, values, creds, xcp, spec, recipeDir, log }) {
  const recipe = fs.readFileSync(path.join(recipeDir, spec.recipe), 'utf8');
  const effective = {
    ...vars,
    ...values,
    answer_file: spec.label,
    ssh_password: `(coffre-fort [${creds.safeName}])`,
    ...(vars.product_key ? { product_key: '(secret)' } : {}),
    remote_host: xcp.host,
    remote_username: xcp.user,
    ssh_wait_timeout: hclValue(recipe, 'ssh_wait_timeout'),
    shutdown_command: hclValue(recipe, 'shutdown_command') ?? recipe.match(/shutdown_command\s*=\s*(\S+)/)?.[1] ?? null,
    boot_command: hclList(recipe, 'boot_command'),
  };
  delete effective.ssh_private_key_file;
  await pool.query('UPDATE jobs SET vars_snapshot = vars_snapshot || $2::jsonb WHERE id = $1',
    [job.id, effective]).catch((e) => console.error(`jobs ${job.id} : instantané non enregistré :`, e.message));
  saveFiles(jobDir(job.id), readTree(recipeDir), log.mask);
}

function logJobHeader(job, vars, log) {
  log.write(`Job ${job.id} : packer ${job.action} — profil « ${job.vars_snapshot.profile} »\n`);
  log.write(`Famille d'OS : ${vars.os_family}${EL_FAMILIES.has(vars.os_family) ? ` ${vars.os_major}` : ''}`
    + ` — firmware : ${vars.firmware === 'uefi' ? `UEFI, Secure Boot ${vars.secure_boot === 'true' ? 'activé' : 'désactivé'}` : 'BIOS'}\n`);
  log.write(`Réseau du build : ${vars.network_mode === 'static' ? `IP fixe ${vars.network_static_ip}` : 'DHCP'}`
    + ` — mise à jour de l'OS : ${vars.os_update === 'true' ? 'oui' : 'non'} — IPv6 : ${vars.ipv6_enabled === 'true' ? 'activé' : 'désactivé'}\n`);
  if (vars.os_type !== 'windows') log.write(`Trace des commandes : ${vars.command_trace === 'true' ? 'activée' : 'désactivée'}\n`);
}

async function connectToMaster(log) {
  const xcp = await withMaster((_call, { creds }) => creds);
  log.addSecrets(xcp.pass);
  log.write(`Maître XCP-ng : ${xcp.host} (compte [${xcp.user}], certificat ${xcp.insecure ? 'non vérifié' : xcp.ca ? 'vérifié par l\'autorité choisie' : 'vérifié par les autorités du système'})\n`);
  return xcp;
}

const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

function caBundle(dir, ca) {
  const file = path.join(dir, 'xcp-ca-bundle.pem');
  const system = fs.existsSync(SYSTEM_CA_BUNDLE) ? fs.readFileSync(SYSTEM_CA_BUNDLE, 'utf8') : '';
  fs.writeFileSync(file, `${system.trimEnd()}\n${ca}`, { mode: 0o644 });
  return file;
}

async function runPacker(job, { recipeDir, varsFile, debugLog, xcp, log, state }) {
  const env = childEnv({
    PACKER_CONFIG_DIR: path.join(DATA_DIR, '.packer.d'),
    PACKER_LOG: '1',
    PACKER_LOG_PATH: debugLog,
    CHECKPOINT_DISABLE: '1',
    PKR_VAR_remote_host: xcp.host,
    PKR_VAR_remote_username: xcp.user,
    PKR_VAR_remote_password: xcp.pass,
    ...(xcp.ca ? { SSL_CERT_FILE: caBundle(path.dirname(debugLog), xcp.ca) } : {}),
  });
  if (state.cancelled) throw new Error("Job annulé avant l'exécution de Packer");
  const opts = { cwd: recipeDir, env, log, state };
  const init = await runCommand('packer', ['init', '-upgrade=false', '.'], opts);
  if (init.code !== 0 || state.cancelled) return init.code;
  const args = job.action === 'build'
    ? ['build', ...(log.colors ? [] : ['-color=false'])]
    : ['validate'];
  const command = [...args, `-var-file=${varsFile}`, '.'];
  const isBuild = job.action === 'build';
  let result = await runCommand('packer', command, { ...opts, tail: isBuild });
  for (let retry = 1; retry <= R15_MAX_RETRIES && isBuild && result.code !== 0
      && !state.cancelled && R15_ERROR.test(stripAnsi(result.tail)); retry++) {
    log.write(`\nRelance automatique du build (${retry}/${R15_MAX_RETRIES}) dans ${R15_PAUSE_MS / 1000} s\n`);
    if (job.vars_snapshot.keep_vm === 'always') {
      log.write('Conservation pour inspection : la VM de la tentative précédente reste sur XCP-ng, à supprimer à la main\n');
    }
    await pauseUnlessCancelled(R15_PAUSE_MS, state);
    if (state.cancelled) break;
    result = await runCommand('packer', command, { ...opts, tail: true });
  }
  return result.code;
}

async function removeBuildCds(log) {
  try {
    await withMaster(async (call) => {
      for (const [ref, vdi] of Object.entries(await call('VDI.get_all_records'))) {
        if (vdi.name_label === BUILD_CD_NAME && !vdi.VBDs.length) {
          await call('VDI.destroy', ref);
          log.write(`CD du build supprimé du SR (${vdi.uuid})\n`);
        }
      }
    });
  } catch (e) {
    log.write(`Attention : CD du build non supprimé, il peut contenir des secrets : ${e.message}\n`);
  }
}

async function checkExistingTemplates(vars, log) {
  const templates = await listTemplates(vars.vm_name);
  const mode = vars.existing_template;
  if (!templates.length) {
    log.write(`Template « ${vars.vm_name} » : aucun existant sur XCP-ng\n`);
    return null;
  }
  if (!replacing(mode)) {
    throw new Error(`Template « ${vars.vm_name} » déjà présent sur XCP-ng (${templates.length}) : build refusé `
      + '(« Template existant » du profil : Refuser si le template existe)');
  }
  log.write(`Template « ${vars.vm_name} » : ${templates.length} existant(s), remplacé(s) si le build réussit`
    + `${mode === EXISTING_TEMPLATE.replacePurge ? ', puis disques supprimés' : ', disques conservés'}\n`);
  for (const t of templates) {
    log.write(`${t.uuid} : ${t.disks.length ? t.disks.map(diskLabel).join(', ') : 'aucun disque'}\n`);
  }
  return templates;
}

async function replaceOldTemplates(job, vars, templates, log) {
  const purge = vars.existing_template === EXISTING_TEMPLATE.replacePurge;
  log.write(`\nRemplacement de l'ancien template${purge ? ' et suppression de ses disques' : ''}\n`);
  const r = await replaceTemplates(vars.vm_name, templates, { purge }, (line) => log.write(`${line}\n`));
  const user = job.vars_snapshot.launched_by || null;
  audit('packer_template_replaced', {
    ...(user ? { user, ip: job.vars_snapshot.launched_from || null } : { actor: 'system' }),
    outcome: !r.failed.length ? 'success' : r.removed.length || r.deleted.length ? 'partial' : 'error',
    target: vars.vm_name,
    job: job.id,
    profile: job.vars_snapshot.profile,
    templates: r.removed,
    deleted: r.deleted.map(diskLabel),
    failed: r.failed.map((f) => ({ target: f.name ? `disque ${f.uuid}` : f.uuid ? `template ${f.uuid}` : vars.vm_name, error: f.error })),
  });
}

async function executeJob(job, { work, recipeDir, varsFile, debugLog, log, state }) {
  const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE id = $1', [job.profile_id]);
  if (!rowCount) throw new Error('Profil supprimé');

  const vars = withBuildDefaults(await normalizeVars(job.vars_snapshot));
  vars.command_trace = vars.os_type === 'windows' ? 'false' : String(await jobCommandTrace());
  if (vars.product_key_entry_id) vars.product_key = await resolveProductKey(vars.product_key_entry_id);
  log.addSecrets(vars.product_key);
  logJobHeader(job, vars, log);
  const xcp = await connectToMaster(log);

  const creds = await buildCredentials(job.vars_snapshot, vars.os_family, work, log);
  const hash = creds.sshPassword ? await sha512Crypt(creds.sshPassword) : LOCKED_PASSWORD;
  if (creds.sshPassword) log.addSecrets(hash);
  const spec = prepareRecipe(PACKER_DIR, recipeDir, {
    vars, hash,
    sshPassword: creds.sshPassword, username: creds.username, publicKey: creds.publicKey,
  });
  const oldTemplates = job.action === 'build' ? await checkExistingTemplates(vars, log) : null;
  const template = await checkTemplate(vars);
  const values = { ...pkrVarValues(vars, creds), ...(await packerSrNames(vars, log)), ...xenExtras(vars), ...buildPlatform(vars, template) };
  fs.writeFileSync(varsFile, toPkrvars(values), { mode: 0o600 });
  await saveSnapshots(job, { vars, values, creds, xcp, spec, recipeDir, log });
  let code;
  try {
    code = await runPacker(job, { recipeDir, varsFile, debugLog, xcp, log, state });
  } finally {
    if (job.action === 'build') await removeBuildCds(log);
  }
  if (code === 0 && !state.cancelled && oldTemplates?.length) await replaceOldTemplates(job, vars, oldTemplates, log);
  return code;
}

function openJob(job) {
  const work = packerWork(job.id);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  return {
    work,
    recipeDir: path.join(work, 'recipe'),
    varsFile: path.join(work, 'vars.pkrvars.hcl'),
    debugLog: path.join(work, DEBUG_LOG),
  };
}

function closeJob(job, { dir, log }, status) {
  if (status !== 'success' && log) log.maskFile(path.join(packerWork(job.id), DEBUG_LOG), path.join(dir, DEBUG_LOG));
  removeSecretArtifacts(job.id);
}
