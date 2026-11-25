import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { tlsOptions } from '../certificates.js';
import { NULL_REF, waitXapiTask, withMaster } from '../xcp.js';
import { splitHost } from '../validation.js';

const DRIVE_NAME = 'XO CloudConfigDrive';
const USER_DATA_MARK = '#cloud-config';
const MAX_DRIVE_BYTES = 256 * 1024 * 1024;
const WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 20 * 1000;
const UNPLUG_WAIT_MS = 10 * 60 * 1000;

function readDrive(creds, session, uuid) {
  const { hostname, port } = splitHost(creds.host);
  const query = new URLSearchParams({ session_id: session, vdi: uuid, format: 'raw' });
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, port, path: `/export_raw_vdi?${query}`, ...tlsOptions(creds), timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`lecture du config drive : HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('lecture du config drive : délai dépassé')));
    req.on('error', reject);
  });
}

async function findDrive(call, vmId) {
  const vm = await call('VM.get_by_uuid', vmId);
  for (const vbd of await call('VM.get_VBDs', vm)) {
    const vdi = await call('VBD.get_VDI', vbd);
    if (vdi !== NULL_REF && await call('VDI.get_name_label', vdi) === DRIVE_NAME) {
      return { vbd, vdi, uuid: await call('VDI.get_uuid', vdi), size: Number(await call('VDI.get_virtual_size', vdi)) };
    }
  }
  return null;
}

const isMissingPvDrivers = (e) => /VM_MISSING_PV_DRIVERS/.test(e.message);

async function detach(call, vbd, { log, state }) {
  await call('VBD.set_unpluggable', vbd, true);
  const deadline = Date.now() + UNPLUG_WAIT_MS;
  for (let waiting = false; ; waiting = true) {
    try {
      await waitXapiTask(call, await call('Async.VBD.unplug_force', vbd), 'débranchement du config drive', Math.max(deadline - Date.now(), POLL_MS));
      return true;
    } catch (e) {
      if (!isMissingPvDrivers(e) || Date.now() + POLL_MS > deadline) throw e;
      if (!waiting) log.write('Config drive : VM en cours de redémarrage (pilotes Xen absents), nouvel essai du débranchement\n');
    }
    await sleep(POLL_MS);
    if (state.cancelled) return false;
  }
}

export function removeWindowsConfigDrive(vmId, { log, state }) {
  return withMaster(async (call, { creds, session }) => {
    const drive = await findDrive(call, vmId);
    if (!drive) return true;
    if (drive.size > MAX_DRIVE_BYTES) throw new Error(`disque « ${DRIVE_NAME} » de taille inattendue`);
    log.write('Config drive : attente de la fin du premier démarrage (effacement du user-data par la VM)\n');
    const deadline = Date.now() + WAIT_MS;
    let wiped = false;
    while (!wiped && !state.cancelled && Date.now() < deadline) {
      const content = await readDrive(creds, session, drive.uuid).catch((e) => {
        log.write(`Attention : ${e.message}\n`);
        return null;
      });
      wiped = content !== null && !content.includes(USER_DATA_MARK);
      if (!wiped) await sleep(POLL_MS);
    }
    if (state.cancelled) return false;
    if (!wiped) {
      log.write(`Erreur : user-data toujours sur le config drive après ${WAIT_MS / 60000} min : le mot de passe y reste, premier démarrage à vérifier\n`);
      return false;
    }
    log.write('Config drive : user-data effacé par la VM\n');
    if (!await detach(call, drive.vbd, { log, state })) return false;
    await call('VDI.destroy', drive.vdi);
    log.write('Config drive : disque supprimé\n');
    return true;
  });
}

