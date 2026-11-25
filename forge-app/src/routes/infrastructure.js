import { Router } from 'express';
import { auditAction, namesFrom } from '../audit.js';
import { auth, handle } from '../http/session.js';
import { pump } from '../jobs.js';
import { batchInput } from '../lists.js';
import { deleteXoSettings, getXoSettings, listXoSubjects, refreshXoStatus, saveXoSettings, testXo, xoCreds, xoStatus } from '../tofu/xo.js';
import { UUID_RE, ValidationError } from '../validation.js';
import * as xcp from '../xcp.js';

export const router = Router();

const hostNames = namesFrom('SELECT id, host AS name FROM xcp_hosts WHERE id::text = ANY($1)');
const rememberXo = async (req) => {
  req.xoHost = (await getXoSettings()).xo_host || null;
  return null;
};
const xoAudit = (event, target = (req) => req.xoHost) => auditAction(event, { context: rememberXo, target });

const withProbe = (fn) => handle(async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    if (e instanceof xcp.ProbeError) return res.status(502).json({ error: e.message });
    throw e;
  }
  pump();
});
const hostId = (req) => {
  if (!UUID_RE.test(req.params.id)) throw new ValidationError('Hôte introuvable');
  return req.params.id;
};

router.get('/api/xcp/hosts', auth, handle(async (_req, res) => res.json(await xcp.listHosts())));
router.post('/api/xcp/hosts', auth, auditAction('xcp_host_created', { names: hostNames, target: (req) => req.body?.host }), withProbe((req) => xcp.saveHost(null, req.body || {})));
router.put('/api/xcp/hosts/:id', auth, auditAction('xcp_host_modified', { names: hostNames }), withProbe((req) => xcp.saveHost(hostId(req), req.body || {})));
router.post('/api/xcp/hosts/batch', auth, auditAction('xcp_host_deleted', { names: hostNames }), handle(async (req, res) => {
  const { ids } = batchInput(req.body, ['delete']);
  const deleted = new Set(await xcp.deleteHosts(ids));
  pump();
  res.json({ done: ids.filter((x) => deleted.has(x)), refused: ids.filter((x) => !deleted.has(x)).map((x) => ({ id: x, error: 'Hôte introuvable' })) });
}));
router.post('/api/xcp/hosts/:id/test', auth,
  auditAction('xcp_host_tested', { names: hostNames, details: (_req, r) => ({ role: r?.role, result: r?.error }) }), handle(async (req, res) => res.json(await xcp.testHost(hostId(req)))));
router.post('/api/xcp/hosts/detect', auth,
  auditAction('xcp_master_detected', { details: (_req, rows) => ({ master: Array.isArray(rows) ? rows.find((r) => r.role === 'master')?.host || null : null }) }), handle(async (_req, res) => {
  await xcp.detectMaster();
  pump();
  res.json(await xcp.listHosts());
}));

router.get('/api/settings/xo', auth, handle(async (_req, res) => res.json({ ...(await getXoSettings()), status: xoStatus() })));
router.put('/api/settings/xo', auth, xoAudit((req) => (req.xoHost ? 'xo_connection_modified' : 'xo_connection_created'), (req) => req.body?.xo_host), handle(async (req, res) => {
  try {
    const saved = await saveXoSettings(req.body || {});
    await refreshXoStatus({ fresh: true });
    res.json(saved);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    res.status(502).json({ error: e.message });
  }
}));
router.post('/api/settings/xo/test', auth, xoAudit('xo_connection_tested'), handle(async (_req, res) => {
  const creds = await xoCreds();
  try {
    const pools = await testXo(creds);
    await refreshXoStatus({ fresh: true });
    res.json({ pools });
  } catch (e) {
    await refreshXoStatus({ fresh: true });
    res.status(502).json({ error: e.message });
  }
}));
router.delete('/api/settings/xo', auth, xoAudit('xo_connection_deleted'), handle(async (_req, res) => {
  await deleteXoSettings();
  await refreshXoStatus({ fresh: true });
  res.json({ ok: true });
}));
router.get('/api/xo/subjects', auth, handle(async (_req, res) => {
  try {
    res.json(await listXoSubjects());
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    res.status(502).json({ error: e.message });
  }
}));

async function withXapi(res, fn) {
  try {
    res.json(await xcp.withMaster(fn));
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    res.status(502).json({ error: `XCP-ng : ${e.message}` });
  }
}

const byName = (a, b) => a.name.localeCompare(b.name);

router.get('/api/xcp/srs', auth, handle((_req, res) => withXapi(res, async (call) => {
  const [srRecords, vmRecords, pbds, hosts] = await Promise.all([call('SR.get_all_records'), call('VM.get_all_records'),
    call('PBD.get_all_records'), call('host.get_all_records')]);
  const hostOf = (ref) => hosts[Object.values(pbds).find((p) => p.SR === ref)?.host]?.name_label;
  const sameName = (name) => Object.values(srRecords).filter((s) => s.name_label === name).length;
  const srs = Object.entries(srRecords).map(([ref, r]) => ({
    value: r.uuid,
    shared_name: sameName(r.name_label) > 1,
    name: r.name_label,
    type: r.type,
    content: r.content_type,
    tip: [r.name_label, r.shared ? 'partagé' : hostOf(ref) && `hôte ${hostOf(ref)}`, r.type,
      `${Math.max(0, Math.round((Number(r.physical_size) - Number(r.physical_utilisation)) / 2 ** 30))} Go libres`, r.uuid].filter(Boolean).join(' · '),
  }));
  return {
    disk: srs.filter((s) => !['iso', 'udev'].includes(s.content) && !['iso', 'udev', 'tmpfs'].includes(s.type)).sort(byName),
    iso: srs.filter((s) => s.content === 'iso' && s.type !== 'udev').sort(byName),
    template: Object.values(vmRecords)
      .filter((v) => v.is_a_template && !v.is_a_snapshot && !v.is_control_domain)
      .map((v) => ({ name: v.name_label }))
      .sort(byName),
  };
})));

router.get('/api/xcp/pool-hosts', auth, handle((_req, res) => withXapi(res, async (call) => {
  const [hosts, pools] = await Promise.all([call('host.get_all_records'), call('pool.get_all_records')]);
  const master = Object.values(pools)[0]?.master;
  return Object.entries(hosts)
    .map(([ref, h]) => ({ name: h.name_label, master: ref === master, meta: `${h.address}${ref === master ? ' · master' : ''}` }))
    .sort((a, b) => b.master - a.master || byName(a, b));
})));

router.get('/api/xcp/networks', auth, handle((_req, res) => withXapi(res, async (call) => Object
  .values(await call('network.get_all_records'))
  .filter((n) => !n.is_host_internal)
  .map((n) => ({ name: n.name_label, meta: n.description || '' }))
  .sort(byName))));
