import { Document, isMap, isScalar, isSeq } from 'yaml';

const STRINGIFY = { lineWidth: 0 };
const YAML_11 = { version: '1.1' };
const TEMPLATE_MARK = /\{[{%#]/;

function markUnsafe(node) {
  if (isScalar(node)) {
    if (typeof node.value === 'string' && TEMPLATE_MARK.test(node.value)) node.tag = '!unsafe';
  } else if (isMap(node)) {
    node.items.forEach((pair) => markUnsafe(pair.value));
  } else if (isSeq(node)) {
    node.items.forEach(markUnsafe);
  }
}

const vaultReference = (key) => `{{ forge_vault.${key} }}`;
const certReference = (key) => `{{ forge_certs.${key} }}`;
const REFERENCES = { vault_entry: ['v', vaultReference], certificate_entry: ['c', certReference] };

function referenceKeys(steps, type) {
  const keys = new Map();
  steps.forEach(({ brick, values }) => brick.parameters
    .filter((p) => p.type === type && values[p.name])
    .forEach((p) => { if (!keys.has(values[p.name])) keys.set(values[p.name], `${REFERENCES[type][0]}${keys.size + 1}`); }));
  return keys;
}

export const vaultKeys = (steps) => referenceKeys(steps, 'vault_entry');
export const certKeys = (steps) => referenceKeys(steps, 'certificate_entry');

export function guidedPlaybook({ name, os, steps, keys = vaultKeys(steps), certs = certKeys(steps) }) {
  const maps = { vault_entry: keys, certificate_entry: certs };
  const stepVars = (brick, values) => Object.fromEntries(brick.parameters
    .filter((p) => values[p.name] !== undefined)
    .map((p) => [p.name, REFERENCES[p.type] ? REFERENCES[p.type][1](maps[p.type].get(values[p.name])) : values[p.name]]));
  const tasks = steps.map(({ brick, values }, i) => {
    const vars = stepVars(brick, values);
    return { name: `Étape ${i + 1} : ${brick.name}`, ...(Object.keys(vars).length ? { vars } : {}), block: brick.tasks };
  });
  const doc = new Document([{
    name, hosts: 'all', gather_facts: true, ...(os === 'linux' ? { become: true } : {}),
    tasks: tasks.length ? tasks : [{ name: 'Aucune étape active', 'ansible.builtin.meta': 'noop' }],
  }], YAML_11);
  markUnsafe(doc.getIn([0, 'name'], true));
  steps.forEach(({ brick }, i) => {
    markUnsafe(doc.getIn([0, 'tasks', i, 'name'], true));
    const varsNode = doc.getIn([0, 'tasks', i, 'vars'], true);
    if (!varsNode) return;
    brick.parameters.filter((p) => !REFERENCES[p.type]).forEach((p) => markUnsafe(varsNode.get(p.name, true)));
    brick.parameters.filter((p) => p.type === 'float').forEach((p) => {
      const node = varsNode.get(p.name, true);
      if (isScalar(node)) node.minFractionDigits = 1;
    });
  });
  return doc.toString(STRINGIFY);
}

export function pingPlaybook(os, withBecome) {
  const tasks = [
    { name: 'Connexion', [os === 'windows' ? 'ansible.windows.win_ping' : 'ansible.builtin.ping']: null },
    ...(os === 'linux' && withBecome ? [{
      name: 'Élévation des droits (sudo)', 'ansible.builtin.command': 'id -un', become: true, changed_when: false,
    }] : []),
  ];
  return new Document([{ name: 'Test de connexion', hosts: 'all', gather_facts: false, tasks }], YAML_11).toString(STRINGIFY);
}

export function inventoryText({ hosts, vault, certs = {} }) {
  const vars = {
    ...(Object.keys(vault).length ? { forge_vault: vault } : {}),
    ...(Object.keys(certs).length ? { forge_certs: certs } : {}),
  };
  const doc = new Document({
    all: {
      ...(Object.keys(vars).length ? { vars } : {}),
      hosts: Object.fromEntries(hosts.map(({ name, vars }) => [name, vars])),
    },
  }, YAML_11);
  markUnsafe(doc.contents);
  return doc.toString(STRINGIFY);
}
