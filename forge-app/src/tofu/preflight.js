import { NULL_REF, srFinder, withMaster } from '../xcp.js';
import { alignMemory, isShutdownBlocked, pendingVmSettings, waitGuestReady, waitRoutableIp } from './vmsettings.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function findUniqueTemplate(allVms, name) {
  const templates = allVms
    .filter(([, v]) => v.is_a_template && !v.is_a_snapshot && v.name_label === name)
    .map(([ref, v]) => ({ ...v, ref }));
  if (!templates.length) throw new Error(`Template « ${name} » introuvable sur le pool`);
  if (templates.length > 1) throw new Error(`Plusieurs templates nommés « ${name} » : nom ambigu, renommer les doublons`);
  return templates[0];
}

async function checkTemplateDisk(call, template, diskSizeGb, imported) {
  let templateDiskBytes = 0;
  for (const vbdRef of template.VBDs || []) {
    const vbd = await call('VBD.get_record', vbdRef);
    if (vbd.type === 'Disk' && vbd.VDI !== NULL_REF) {
      templateDiskBytes = Math.max(templateDiskBytes, Number(await call('VDI.get_virtual_size', vbd.VDI)));
    }
  }
  if (!imported && templateDiskBytes > Number(diskSizeGb) * GiB) {
    throw new Error(`Disque du profil (${diskSizeGb} Go) inférieur au disque du template (${Math.ceil(templateDiskBytes / GiB)} Go)`);
  }
  return templateDiskBytes;
}

async function resolveStorage(call, vars, template) {
  const find = srFinder(await call('SR.get_all_records'));
  const findSr = (uuid, label) => {
    const sr = find(uuid, label);
    if (['iso', 'udev'].includes(sr.content_type)) throw new Error(`${label} : SR « ${sr.name_label} » réservé aux ISO ou aux périphériques`);
    return sr;
  };
  const vmSrs = [findSr(vars.sr_uuid, 'Disque principal')];
  const extraDisks = vars.extra_disks || [];
  if (!extraDisks.length) return vmSrs;

  const free = (await call('VM.get_allowed_VBD_devices', template.ref)).length - 1;
  if (extraDisks.length > free) {
    throw new Error(`Disques supplémentaires : ${extraDisks.length} demandés, ${Math.max(0, free)} emplacement(s) libre(s) sur le template`);
  }
  const requestedBySr = {};
  for (const disk of extraDisks) requestedBySr[disk.sr_uuid] = (requestedBySr[disk.sr_uuid] || 0) + disk.size_gb;
  for (const [uuid, gb] of Object.entries(requestedBySr)) {
    const sr = findSr(uuid, 'Disques supplémentaires');
    vmSrs.push(sr);
    const freeGb = Math.floor((Number(sr.physical_size) - Number(sr.physical_utilisation)) / GiB);
    if (sr.type.startsWith('lvm') && gb > freeGb) throw new Error(`SR « ${sr.name_label} » : ${gb} Go demandés, ${freeGb} Go libres`);
  }
  return vmSrs;
}

const MASTER_AFFINITY = '__master__';

async function checkAffinityHost(call, vars, masterRef, vmSrs) {
  const hosts = Object.entries(await call('host.get_all_records'));
  const named = vars.affinity_host && vars.affinity_host !== MASTER_AFFINITY;
  const affinity = named
    ? hosts.filter(([, h]) => h.name_label === vars.affinity_host)
    : hosts.filter(([ref]) => ref === masterRef);
  if (affinity.length !== 1) {
    throw new Error(`Hôte d'affinité « ${named ? vars.affinity_host : 'master'} » ${affinity.length ? 'ambigu (plusieurs hôtes de ce nom)' : 'introuvable'}`);
  }
  const [hostRef, host] = affinity[0];
  const pbds = Object.values(await call('PBD.get_all_records'));
  for (const sr of vmSrs) {
    if (!sr.shared && !pbds.some((p) => p.SR === sr.$ref && p.host === hostRef && p.currently_attached)) {
      throw new Error(`SR « ${sr.name_label} » non partagé et non branché sur l'hôte d'affinité « ${host.name_label} »`);
    }
  }
  return { ...host, ref: hostRef };
}

async function checkNetworks(call, vars, template) {
  const allNets = Object.values(await call('network.get_all_records'));
  const extraNetworks = vars.extra_networks || [];
  for (const name of new Set([vars.network, ...extraNetworks.map((n) => n.network)])) {
    const nets = allNets.filter((n) => n.name_label === name);
    if (nets.length !== 1) throw new Error(`Réseau « ${name} » ${nets.length ? 'ambigu (plusieurs réseaux de ce nom)' : 'introuvable'}`);
  }
  const vifSlots = (await call('VM.get_allowed_VIF_devices', template.ref)).length + (template.VIFs || []).length;
  if (1 + extraNetworks.length > vifSlots) {
    throw new Error(`Interfaces : ${1 + extraNetworks.length} demandées, ${vifSlots} au maximum sur le template`);
  }
}

const XEN_OVERHEAD_FIXED = 32 * MiB;
const XEN_OVERHEAD_RATIO = 0.01;

async function checkHostMemory(call, vars, affinity, ownVm, repair, log) {
  const vm = ownVm?.[1];
  const running = vm?.power_state === 'Running';
  const hostRef = running ? vm.resident_on : affinity.ref;
  const wanted = Number(vars.vm_memory) * MiB;
  const inUse = running ? Number(vm.memory_dynamic_max) : 0;
  if (wanted <= inUse) return;
  const needed = wanted - inUse + (running ? 0 : XEN_OVERHEAD_FIXED + Math.ceil(wanted * XEN_OVERHEAD_RATIO));
  const free = Number(await call('host.compute_free_memory', hostRef));
  if (needed <= free) return;
  const hostName = running ? await call('host.get_name_label', hostRef) : affinity.name_label;
  const message = `Mémoire insuffisante sur l'hôte « ${hostName} » : ${Math.ceil(needed / MiB)} Mo nécessaires `
    + `(${running ? `${vars.vm_memory} Mo demandés, ${Math.round(inUse / MiB)} Mo déjà utilisés par la VM` : `${vars.vm_memory} Mo et la part de Xen`}), `
    + `${Math.floor(free / MiB)} Mo libres : arrêter une VM ou réduire la mémoire du profil`;
  if (repair) throw new Error(message);
  log.write(`Attention : ${message}\n`);
}

async function readVmDiskSizes(call, vm) {
  const sizes = { system: 0, byName: {} };
  for (const vbdRef of vm.VBDs || []) {
    const vbd = await call('VBD.get_record', vbdRef);
    if (vbd.type === 'Disk' && vbd.VDI !== NULL_REF) {
      const vdi = await call('VDI.get_record', vbd.VDI);
      if (vbd.userdevice === '0') sizes.system = Number(vdi.virtual_size);
      else sizes.byName[vdi.name_label] = Number(vdi.virtual_size);
    }
  }
  return sizes;
}

function checkMemoryMin(vars, source, label) {
  const min = Number(source.memory_static_min);
  if (Number(vars.vm_memory) * MiB < min) {
    throw new Error(`Mémoire du profil (${vars.vm_memory} Mo) inférieure au minimum statique ${label} (${Math.round(min / MiB)} Mo) : `
      + `la porter à au moins ${Math.round(min / MiB)} Mo`);
  }
}

async function checkDeployedVm(call, vars, [vmRef, vm], { waitGuest, repair, log, state }) {
  checkMemoryMin(vars, vm, 'de la VM');
  const current = await readVmDiskSizes(call, vm);
  const disks = [
    { name: vars.disk_name || `${vars.vm_name}-disk0`, gb: Number(vars.disk_size), size: current.system },
    ...(vars.extra_disks || []).map((d) => ({ name: d.name, gb: d.size_gb, size: current.byName[d.name] || 0 })),
  ];
  const shrunk = disks.filter((d) => d.size > d.gb * GiB);
  if (shrunk.length) {
    throw new Error(`Réduction de disque impossible : ${shrunk.map((d) => `« ${d.name} » ${d.gb} Go demandés, ${Math.ceil(d.size / GiB)} Go actuels`).join(' ; ')}`);
  }
  const grown = disks.some((d) => d.size && d.size < d.gb * GiB);
  const vcpus = Number(vars.vcpus);
  const needsHalt = vcpus > Number(vm.VCPUs_max) || Number(vars.vm_memory) * MiB !== Number(vm.memory_static_max) || grown;
  const hotplug = vcpus !== Number(vm.VCPUs_at_startup);
  if (vm.power_state !== 'Running' && needsHalt) {
    throw new Error(`VM « ${vm.name_label} » à l'état ${vm.power_state} : vCPU au-delà de ${vm.VCPUs_max}, mémoire et taille `
      + 'des disques ne se modifient que VM démarrée. La démarrer (dans Xen Orchestra, ou par un apply sans ces changements), puis relancer');
  }
  const pending = pendingVmSettings(vars, vm).map((p) => p.label);
  if (isShutdownBlocked(vm) && needsHalt) {
    throw new Error(`VM « ${vm.name_label} » protégée contre l'arrêt : vCPU au-delà de ${vm.VCPUs_max}, mémoire et taille des disques `
      + 'demandent de l\'arrêter. Désactiver « Protect from accidental shutdown », lancer « Construire », puis refaire la modification');
  }
  if (isShutdownBlocked(vm) && pending.length && vars.protect_shutdown === 'true') {
    throw new Error(`VM « ${vm.name_label} » protégée contre l'arrêt : ${pending.join(', ')} demande de l'arrêter. `
      + 'Désactiver « Protect from accidental shutdown » dans le profil, puis relancer');
  }
  if (pending.length) log.write(`Réglages Xen à appliquer : ${pending.join(', ')} (arrêt puis redémarrage de la VM à l'étape « Construire »)\n`);
  if (vm.power_state === 'Running' && (needsHalt || hotplug) && waitGuest) {
    await waitGuestReady(call, vmRef, vm.name_label, log, state);
  }
  const wanted = Number(vars.vm_memory) * MiB;
  const staticMax = Number(vm.memory_static_max);
  const incoherent = staticMax !== wanted && Number(vm.memory_dynamic_max) === wanted;
  if (incoherent || wanted < staticMax) {
    const detail = incoherent
      ? `Mémoire incohérente sur la VM (statique ${Math.round(staticMax / MiB)} Mo, dynamique ${vars.vm_memory} Mo)`
      : `Mémoire ${Math.round(staticMax / MiB)} → ${vars.vm_memory} Mo`;
    if (!repair) {
      log.write(`${detail} : Forge arrêtera la VM, alignera les limites et la redémarrera au prochain apply\n`);
      return {};
    }
    log.write(`${detail} : arrêt, limites alignées sur ${vars.vm_memory} Mo, redémarrage\n`);
    await alignMemory(call, vmRef, vm, wanted, log);
    if (waitGuest) await waitGuestReady(call, vmRef, vm.name_label, log, state);
    if (waitGuest && vars.wait_for_ip !== 'false') await waitRoutableIp(vm.uuid, { state });
    log.write(incoherent ? 'Mémoire de la VM réparée\n' : 'Mémoire de la VM baissée\n');
    return {};
  }
  return staticMax !== wanted ? { memoryFrom: Math.round(staticMax / MiB) } : {};
}

function warnFirmwareMismatch(vars, source, sourceLabel, log) {
  const wanted = vars.boot_firmware || 'bios';
  const current = source.HVM_boot_params?.firmware || 'bios';
  if (wanted !== current) {
    log.write(`Attention : boot firmware « ${wanted} » demandé, « ${current} » sur ${sourceLabel} : le système installé risque de ne pas démarrer\n`);
  }
}

async function checkDestroyable(call, vmId) {
  const vmRef = await call('VM.get_by_uuid', vmId).catch((e) => {
    if (e.xapi?.code === 'UUID_INVALID') return null;
    throw e;
  });
  if (!vmRef) return;
  const vm = await call('VM.get_record', vmRef);
  const shutdownBlocked = vm.power_state !== 'Halted' && isShutdownBlocked(vm);
  if ('destroy' in vm.blocked_operations || shutdownBlocked) {
    const toggles = [
      ...('destroy' in vm.blocked_operations ? ['« Protect from accidental deletion »'] : []),
      ...(shutdownBlocked ? ['« Protect from accidental shutdown »'] : []),
    ];
    throw new Error(`VM « ${vm.name_label} » protégée : désactiver ${toggles.join(' et ')} dans le profil, lancer « Construire », puis relancer la destruction`);
  }
}

async function checkOrphanMac(call, allVms, mac, ownVmId) {
  const vms = new Map(allVms);
  for (const vif of Object.values(await call('VIF.get_all_records'))) {
    const vm = vms.get(vif.VM);
    if (vif.MAC.toLowerCase() === mac && vm && !vm.is_a_template && !vm.is_a_snapshot && vm.uuid !== ownVmId) {
      throw new Error(`La VM « ${vm.name_label} » (${vm.uuid}) porte l'adresse MAC du profil sans être gérée par son état `
        + '(déploiement interrompu) : la supprimer dans Xen Orchestra, ou supprimer ce profil puis reprendre la VM avec « Importer une VM »');
    }
  }
}

async function checkStaticIpsFree(call, vars, allVms, ownVmId) {
  const staticIps = [vars.network_static_ip, ...(vars.extra_networks || []).map((n) => n.ip)].filter(Boolean);
  if (!staticIps.length) return;
  const metrics = await call('VM_guest_metrics.get_all_records');
  for (const [, vm] of allVms) {
    if (!vm.is_a_template && !vm.is_control_domain && vm.power_state === 'Running' && vm.uuid !== ownVmId) {
      const used = new Set(Object.values(metrics[vm.guest_metrics]?.networks || {}));
      const clash = staticIps.filter((ip) => used.has(ip));
      if (clash.length) throw new Error(`Adresse IP ${clash.join(', ')} déjà utilisée par la VM « ${vm.name_label} »`);
    }
  }
}

async function checkDeployment(call, vars, pool, { log, ownVmId, mac, waitGuest, repair, state }) {
  const allVms = Object.entries(await call('VM.get_all_records'));
  const template = findUniqueTemplate(allVms, vars.source_template);
  const templateDiskBytes = await checkTemplateDisk(call, template, vars.disk_size, vars.imported === 'true');
  const vmSrs = await resolveStorage(call, vars, template);
  const host = await checkAffinityHost(call, vars, pool?.master, vmSrs);
  await checkNetworks(call, vars, template);
  const ownVm = ownVmId && allVms.find(([, v]) => v.uuid === ownVmId);
  if (!ownVm) checkMemoryMin(vars, template, `du template « ${template.name_label} »`);
  await checkHostMemory(call, vars, host, ownVm, repair, log);
  const deployed = ownVm ? await checkDeployedVm(call, vars, ownVm, { waitGuest, repair, log, state }) : {};
  warnFirmwareMismatch(vars, ownVm ? ownVm[1] : template, ownVm ? 'la VM' : 'le modèle source', log);
  if (mac) await checkOrphanMac(call, allVms, mac, ownVmId);
  await checkStaticIpsFree(call, vars, allVms, ownVmId);
  log.write(`Pré-vérification XCP-ng : OK (pool ${pool?.uuid || null}, hôte d'affinité ${host.name_label}, disque du template ${Math.ceil(templateDiskBytes / GiB)} Go)\n`);
  return deployed;
}

export function preflight(vars, log, { full = true, ownVmId = null, mac = null, waitGuest = false, repair = false, state = null } = {}) {
  return withMaster(async (call) => {
    const [pool] = Object.values(await call('pool.get_all_records'));
    let deployed = {};
    if (full) deployed = await checkDeployment(call, vars, pool, { log, ownVmId, mac, waitGuest, repair, state });
    else if (ownVmId) await checkDestroyable(call, ownVmId);
    return { poolId: pool?.uuid || null, ...deployed };
  });
}
