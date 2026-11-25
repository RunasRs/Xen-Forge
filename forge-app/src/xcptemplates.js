import { NULL_REF, withMaster } from './xcp.js';

export const EXISTING_TEMPLATE = { refuse: 'refuse', replace: 'replace', replacePurge: 'replace_purge' };
const GIB = 1024 ** 3;

export const diskLabel = (d) => `« ${d.name} » (${d.uuid}, ${(d.size / GIB).toFixed(1)} Go, SR « ${d.sr} »)`;

const missing = (e) => e.xapi?.code === 'UUID_INVALID';

export function listTemplates(name) {
  return withMaster(async (call) => {
    const templates = [];
    for (const ref of await call('VM.get_by_name_label', name)) {
      const vm = await call('VM.get_record', ref);
      if (!vm.is_a_template || vm.is_a_snapshot) continue;
      const disks = [];
      for (const vbdRef of vm.VBDs) {
        const vbd = await call('VBD.get_record', vbdRef);
        if (vbd.type !== 'Disk' || vbd.VDI === NULL_REF) continue;
        const vdi = await call('VDI.get_record', vbd.VDI);
        const sr = await call('SR.get_record', vdi.SR);
        if (sr.content_type === 'iso') continue;
        disks.push({ uuid: vdi.uuid, name: vdi.name_label, size: Number(vdi.virtual_size), sr: sr.name_label });
      }
      templates.push({ uuid: vm.uuid, disks });
    }
    return templates;
  });
}

async function deleteOrphanDisks(templates, report) {
  const deleted = [];
  const failed = [];
  const kept = [];
  try {
    await withMaster(async (call) => {
      for (const t of templates) {
        if (await call('VM.get_by_uuid', t.uuid).then(() => true, (e) => (missing(e) ? false : Promise.reject(e)))) {
          kept.push(t.uuid);
          report(`Ancien template ${t.uuid} toujours présent : ses disques sont conservés`);
          continue;
        }
        for (const d of t.disks) {
          try {
            const ref = await call('VDI.get_by_uuid', d.uuid);
            if ((await call('VDI.get_VBDs', ref)).length) {
              failed.push({ ...d, error: 'rattaché à une VM' });
              report(`Attention : disque ${diskLabel(d)} rattaché à une VM, conservé`);
              continue;
            }
            await call('VDI.destroy', ref);
            deleted.push(d);
            report(`Disque supprimé : ${diskLabel(d)}`);
          } catch (e) {
            if (missing(e)) {
              report(`Disque ${d.uuid} déjà absent`);
              continue;
            }
            failed.push({ ...d, error: e.message });
            report(`Attention : disque ${diskLabel(d)} non supprimé : ${e.message}`);
          }
        }
      }
    });
  } catch (e) {
    const done = new Set([...deleted, ...failed].map((d) => d.uuid));
    templates.filter((t) => !kept.includes(t.uuid)).flatMap((t) => t.disks).filter((d) => !done.has(d.uuid))
      .forEach((d) => failed.push({ ...d, error: e.message }));
    report(`Attention : suppression des disques interrompue : ${e.message}`);
  }
  return { deleted, failed };
}

async function destroyTemplates(templates, report) {
  const removed = [];
  const failed = [];
  try {
    await withMaster(async (call) => {
      for (const t of templates) {
        try {
          await call('VM.destroy', await call('VM.get_by_uuid', t.uuid));
          removed.push(t.uuid);
          report(`Ancien template supprimé : ${t.uuid}`);
        } catch (e) {
          if (missing(e)) {
            removed.push(t.uuid);
            report(`Ancien template ${t.uuid} déjà absent`);
            continue;
          }
          failed.push({ uuid: t.uuid, error: e.message });
          report(`Attention : ancien template ${t.uuid} non supprimé : ${e.message}`);
        }
      }
    });
  } catch (e) {
    const done = new Set([...removed, ...failed.map((f) => f.uuid)]);
    templates.filter((t) => !done.has(t.uuid)).forEach((t) => failed.push({ uuid: t.uuid, error: e.message }));
    report(`Attention : suppression des anciens templates interrompue : ${e.message}`);
  }
  return { removed, failed };
}

export async function replaceTemplates(name, oldTemplates, { purge }, report) {
  const result = { removed: [], deleted: [], failed: [] };
  const oldIds = new Set(oldTemplates.map((t) => t.uuid));
  try {
    if (!(await listTemplates(name)).some((t) => !oldIds.has(t.uuid))) {
      report('Attention : nouveau template introuvable, anciens templates conservés');
      result.failed.push({ error: 'nouveau template introuvable' });
      return result;
    }
  } catch (e) {
    report(`Attention : templates non relus, anciens templates conservés : ${e.message}`);
    result.failed.push({ error: e.message });
    return result;
  }
  const { removed, failed } = await destroyTemplates(oldTemplates, report);
  result.removed = removed;
  result.failed.push(...failed);
  if (purge) {
    const disks = await deleteOrphanDisks(oldTemplates.filter((t) => removed.includes(t.uuid)), report);
    result.deleted = disks.deleted;
    result.failed.push(...disks.failed.map((d) => ({ uuid: d.uuid, name: d.name, sr: d.sr, error: d.error })));
  }
  return result;
}
