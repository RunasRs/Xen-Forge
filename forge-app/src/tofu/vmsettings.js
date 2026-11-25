import { setTimeout as sleep } from 'node:timers/promises';
import { NULL_REF, waitXapiTask, withMaster } from '../xcp.js';

const GUEST_READY_TIMEOUT_MS = 5 * 60 * 1000;
const GUEST_POLL_MS = 5000;
const POWER_TASK_TIMEOUT_MS = 10 * 60 * 1000;

const SHUTDOWN_OPERATIONS = ['clean_reboot', 'clean_shutdown', 'hard_reboot', 'hard_shutdown', 'pause', 'suspend', 'shutdown'];
const MIGRATION_OPERATIONS = ['migrate_send', 'pool_migrate'];
const NIC_LABELS = { rtl8139: 'Realtek RTL8139', e1000: 'Intel e1000' };

export function blockedOperations(vars) {
  return [
    ...(vars.protect_delete === 'true' ? ['destroy'] : []),
    ...(vars.protect_shutdown === 'true' ? SHUTDOWN_OPERATIONS : []),
    ...(vars.prevent_migration === 'true' ? MIGRATION_OPERATIONS : []),
  ];
}

export const isShutdownBlocked = (vm) => SHUTDOWN_OPERATIONS.some((op) => op in vm.blocked_operations);

export async function waitGuestReady(call, vmRef, name, log, state) {
  const deadline = Date.now() + GUEST_READY_TIMEOUT_MS;
  for (let waiting = false; ; waiting = true) {
    const metrics = await call('VM.get_guest_metrics', vmRef);
    if (metrics !== NULL_REF && Object.keys(await call('VM_guest_metrics.get_PV_drivers_version', metrics)).length) {
      if (waiting) log.write('Agent invité signalé : VM prête\n');
      return;
    }
    if (state?.cancelled) throw new Error("Job annulé pendant l'attente de l'agent invité");
    if (Date.now() > deadline) {
      throw new Error(`VM « ${name} » : agent invité non signalé après ${GUEST_READY_TIMEOUT_MS / 60000} min : vérifier l'invité (xen-guest-agent) puis relancer`);
    }
    if (!waiting) log.write(`VM « ${name} » en cours de démarrage : attente de son agent invité\n`);
    await sleep(GUEST_POLL_MS);
  }
}

async function setPlatformKey(call, vmRef, key, value) {
  await call('VM.remove_from_platform', vmRef, key);
  if (value !== null) await call('VM.add_to_platform', vmRef, key, value);
}

function platformFixes(vars, vm) {
  const uefi = vars.boot_firmware === 'uefi';
  const std = vars.vga !== 'false';
  const expected = [
    ['device-model', `qemu-upstream-${uefi ? 'uefi' : 'compat'}`, vm.platform['device-model'], 'modèle de machine'],
    ['vga', std ? 'std' : 'cirrus', vm.platform.vga || 'cirrus', 'VGA'],
    ...(std ? [['videoram', String(vars.videoram || 8), vm.platform.videoram, 'Video RAM']] : []),
    ...(uefi ? [['secureboot', String(vars.secure_boot === 'true'), vm.platform.secureboot || 'false', 'Secure Boot']] : []),
  ];
  return expected.filter(([, want, actual]) => want !== actual).map(([key, want, actual, label]) => ({
    label: `${label} ${actual ?? 'absent'} → ${want}`,
    apply: (call, vmRef) => setPlatformKey(call, vmRef, key, want),
  }));
}

export function pendingVmSettings(vars, vm) {
  const pending = [];
  if (vars.nic_type && (vm.platform.nic_type || 'rtl8139') !== vars.nic_type) {
    pending.push({
      label: `NIC type ${NIC_LABELS[vars.nic_type]}`,
      apply: (call, vmRef) => setPlatformKey(call, vmRef, 'nic_type', vars.nic_type === 'rtl8139' ? null : vars.nic_type),
    });
  }
  const vendorDevice = vars.citrix_pv_drivers === 'true';
  if (vars.os_type === 'windows' && vars.citrix_pv_drivers && vm.has_vendor_device !== vendorDevice) {
    pending.push({
      label: `pilotes Citrix PV par Windows Update ${vendorDevice ? 'activés' : 'désactivés'}`,
      apply: (call, vmRef) => call('VM.set_has_vendor_device', vmRef, vendorDevice),
    });
  }
  return pending;
}

const withoutShutdownBlocks = (operations) => Object.fromEntries(
  Object.entries(operations).filter(([op]) => !SHUTDOWN_OPERATIONS.includes(op)),
);

async function restartWith(call, vmRef, vm, pending, log) {
  const protectedVm = isShutdownBlocked(vm);
  if (protectedVm) await call('VM.set_blocked_operations', vmRef, withoutShutdownBlocks(vm.blocked_operations));
  try {
    log.write('Réglages Xen : arrêt de la VM\n');
    await waitXapiTask(call, await call('Async.VM.clean_shutdown', vmRef), 'arrêt de la VM', POWER_TASK_TIMEOUT_MS);
    try {
      for (const setting of pending) await setting.apply(call, vmRef);
    } finally {
      log.write('Réglages Xen : démarrage de la VM\n');
      await waitXapiTask(call, await call('Async.VM.start', vmRef, false, false), 'démarrage de la VM', POWER_TASK_TIMEOUT_MS);
    }
  } finally {
    if (protectedVm) await call('VM.set_blocked_operations', vmRef, vm.blocked_operations);
  }
}

export function alignMemory(call, vmRef, vm, bytes, log) {
  return restartWith(call, vmRef, vm, [{
    apply: (c, ref) => c('VM.set_memory_limits', ref, Number(vm.memory_static_min), bytes, bytes, bytes),
  }], log);
}

const LINK_LOCAL_RE = /^169\.254\./;
const IPV4_VALUE_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const REAL_IP_TIMEOUT_MS = 5 * 60 * 1000;
export const onlyLinkLocal = (ips) => Array.isArray(ips) && ips.length > 0 && ips.every((ip) => LINK_LOCAL_RE.test(ip));

export function waitRoutableIp(vmId, { state, timeoutMs = REAL_IP_TIMEOUT_MS } = {}) {
  return withMaster(async (call) => {
    const vmRef = await call('VM.get_by_uuid', vmId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const metrics = await call('VM.get_guest_metrics', vmRef);
      const networks = metrics === NULL_REF ? {} : await call('VM_guest_metrics.get_networks', metrics);
      const ip = Object.values(networks).find((v) => IPV4_VALUE_RE.test(v) && !LINK_LOCAL_RE.test(v));
      if (ip) return ip;
      if (state?.cancelled || Date.now() > deadline) return null;
      await sleep(GUEST_POLL_MS);
    }
  });
}

export function applyVmSettings(vmId, vars, { log, state }) {
  return withMaster(async (call) => {
    const vmRef = await call('VM.get_by_uuid', vmId);
    const vm = await call('VM.get_record', vmRef);
    const pending = [...pendingVmSettings(vars, vm), ...platformFixes(vars, vm)];
    if (!pending.length) return;
    log.write(`Réglages Xen à appliquer VM arrêtée : ${pending.map((p) => p.label).join(', ')}\n`);
    await waitGuestReady(call, vmRef, vm.name_label, log, state);
    if (state.cancelled) throw new Error('Job annulé avant l\'arrêt de la VM');
    await restartWith(call, vmRef, vm, pending, log);
    log.write('Réglages Xen : appliqués\n');
    if (vars.wait_for_ip !== 'false') await waitGuestReady(call, vmRef, vm.name_label, log, state);
  });
}
