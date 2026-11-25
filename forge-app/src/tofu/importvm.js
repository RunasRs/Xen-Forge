import { pool } from '../db.js';
import { NULL_REF, withMaster } from '../xcp.js';
import { ValidationError } from '../validation.js';
import { profileMac } from './cloudinit.js';
import { tofuStateSummary } from './state.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const CONFIG_DRIVE = 'XO CloudConfigDrive';
const SHUTDOWN_OPERATIONS = ['clean_reboot', 'clean_shutdown', 'hard_reboot', 'hard_shutdown', 'pause', 'suspend', 'shutdown'];
const MIGRATION_OPERATIONS = ['migrate_send', 'pool_migrate'];
const VIDEORAM = ['1', '2', '4', '8', '16'];

async function profileClaims() {
  const { rows } = await pool.query('SELECT id, name, vars FROM tofu_profiles');
  const vmIds = new Map();
  const macs = new Map();
  for (const p of rows) {
    const vmId = (await tofuStateSummary(p.id).catch(() => null))?.vm?.id;
    if (vmId) vmIds.set(vmId, p.name);
    macs.set(p.vars?.vm_mac || profileMac(p.id), p.name);
  }
  return { vmIds, macs };
}

const isGuestVm = (vm) => !vm.is_a_template && !vm.is_a_snapshot && !vm.is_control_domain;

function guessOs(vm, metrics) {
  const os = metrics?.os_version || {};
  if (/windows/i.test(`${os.name || ''} ${os.distro || ''}`)) return 'windows';
  if (os.name || os.distro) return 'linux';
  return vm.platform?.viridian === 'true' ? 'windows' : 'linux';
}

function detectTemplate(vm, templatesByUuid) {
  for (const [key, value] of Object.entries(vm.other_config || {})) {
    if (!key.startsWith('xo:')) continue;
    try {
      const name = templatesByUuid.get(JSON.parse(value)?.creation?.template);
      if (name) return name;
    } catch { }
  }
  return '';
}

const templateNames = (vms) => new Map(Object.values(vms).filter((v) => v.is_a_template && !v.is_a_snapshot).map((v) => [v.uuid, v.name_label]));

function claimOf(claims, vm, vifs) {
  const managedBy = claims.vmIds.get(vm.uuid);
  if (managedBy) return { profile: managedBy, managed: true };
  const macOf = vm.VIFs.map((ref) => claims.macs.get(vifs[ref]?.MAC?.toLowerCase())).find(Boolean);
  return macOf ? { profile: macOf, managed: false } : null;
}

export async function listImportableVms() {
  const claims = await profileClaims();
  return withMaster(async (call) => {
    const [vms, vifs, metrics] = await Promise.all([
      call('VM.get_all_records'), call('VIF.get_all_records'), call('VM_guest_metrics.get_all_records')]);
    const templates = templateNames(vms);
    return Object.values(vms).filter(isGuestVm)
      .filter((vm) => !claimOf(claims, vm, vifs))
      .map((vm) => ({
        uuid: vm.uuid,
        name: vm.name_label,
        power_state: vm.power_state,
        os_type: guessOs(vm, metrics[vm.guest_metrics]),
        source_template: detectTemplate(vm, templates),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

async function readDisks(call, vm) {
  const disks = [];
  for (const ref of vm.VBDs) {
    const vbd = await call('VBD.get_record', ref);
    if (vbd.type !== 'Disk' || vbd.VDI === NULL_REF) continue;
    const vdi = await call('VDI.get_record', vbd.VDI);
    if (vdi.name_label === CONFIG_DRIVE) continue;
    const bytes = Number(vdi.virtual_size);
    if (bytes % GiB) {
      throw new ValidationError(`Disque « ${vdi.name_label} » : taille ${bytes} octets, pas un nombre entier de Go (le profil compte en Go) : l'agrandir au Go supérieur dans Xen Orchestra avant l'import`);
    }
    disks.push({ position: Number(vbd.userdevice), name: vdi.name_label, sr_uuid: await call('SR.get_uuid', vdi.SR), size_gb: bytes / GiB });
  }
  if (!disks.length) throw new ValidationError('VM sans disque : import impossible');
  return disks.sort((a, b) => a.position - b.position);
}

async function readMainNetwork(call, vm) {
  const vifs = await Promise.all(vm.VIFs.map((ref) => call('VIF.get_record', ref)));
  if (!vifs.length) throw new ValidationError('VM sans interface réseau : import impossible');
  vifs.sort((a, b) => Number(a.device) - Number(b.device));
  return { network: await call('network.get_name_label', vifs[0].network), mac: vifs[0].MAC.toLowerCase() };
}

function xenSettings(vm, affinityName) {
  const blocked = Object.keys(vm.blocked_operations || {});
  const platform = vm.platform || {};
  return {
    auto_poweron: String(vm.other_config?.auto_poweron === 'true'),
    protect_delete: String(blocked.includes('destroy')),
    protect_shutdown: String(SHUTDOWN_OPERATIONS.some((op) => blocked.includes(op))),
    prevent_migration: String(MIGRATION_OPERATIONS.some((op) => blocked.includes(op))),
    citrix_pv_drivers: String(!!vm.has_vendor_device),
    high_availability: ['restart', 'best-effort'].includes(vm.ha_restart_priority) ? vm.ha_restart_priority : '',
    nic_type: platform.nic_type === 'e1000' ? 'e1000' : 'rtl8139',
    vga: String(platform.vga === 'std'),
    videoram: VIDEORAM.includes(platform.videoram) ? platform.videoram : '8',
    boot_firmware: vm.HVM_boot_params?.firmware === 'uefi' ? 'uefi' : 'bios',
    secure_boot: String(vm.HVM_boot_params?.firmware === 'uefi' && platform.secureboot === 'true'),
    affinity_host: affinityName,
  };
}

export async function readVmForImport(vmId) {
  const claims = await profileClaims();
  return withMaster(async (call) => {
    const ref = await call('VM.get_by_uuid', vmId).catch((e) => {
      if (e.xapi?.code === 'UUID_INVALID' || /UUID_INVALID/.test(e.message)) throw new ValidationError(`VM ${vmId} introuvable dans XCP-ng`);
      throw e;
    });
    const vm = await call('VM.get_record', ref);
    if (!isGuestVm(vm)) throw new ValidationError(`« ${vm.name_label} » n'est pas une VM (modèle, snapshot ou dom0)`);
    const vifs = Object.fromEntries(await Promise.all(vm.VIFs.map(async (r) => [r, await call('VIF.get_record', r)])));
    const claimedBy = claimOf(claims, vm, vifs);
    if (claimedBy?.managed) throw new ValidationError(`VM « ${vm.name_label} » déjà gérée par le profil « ${claimedBy.profile} »`);
    if (claimedBy) {
      throw new ValidationError(`VM « ${vm.name_label} » : elle porte l'adresse MAC du profil « ${claimedBy.profile} » (déploiement interrompu). `
        + 'Supprimer ce profil, puis importer la VM');
    }
    const [main, ...extra] = await readDisks(call, vm);
    const net = await readMainNetwork(call, vm);
    const metrics = vm.guest_metrics === NULL_REF ? null : await call('VM_guest_metrics.get_record', vm.guest_metrics);
    const templates = templateNames(await call('VM.get_all_records'));
    const affinityName = vm.affinity === NULL_REF ? '' : await call('host.get_name_label', vm.affinity);
    const staticMax = Number(vm.memory_static_max);
    const cores = Number(vm.platform?.['cores-per-socket']);
    return {
      detected: { os_type: guessOs(vm, metrics), source_template: detectTemplate(vm, templates) },
      vars: {
        vm_name: vm.name_label,
        vm_description: vm.name_description || '',
        vcpus: Number(vm.VCPUs_max),
        ...(cores > 0 ? { cores_per_socket: cores } : {}),
        vm_memory: Math.round(staticMax / MiB),
        disk_size: main.size_gb,
        disk_name: main.name,
        sr_uuid: main.sr_uuid,
        extra_disks: extra.map(({ name, sr_uuid, size_gb }) => ({ name, sr_uuid, size_gb })),
        network: net.network,
        vm_mac: net.mac,
        vm_uuid: vm.uuid,
        tags: (vm.tags || []).map((t) => t.trim()).filter(Boolean).join(','),
        ...xenSettings(vm, affinityName),
        imported: 'true',
        clone_type: 'full',
        wait_for_ip: 'true',
        destroy_cloud_config: 'false',
        network_mode: 'dhcp',
      },
    };
  });
}
