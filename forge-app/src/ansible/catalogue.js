import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { CIDR_RE, IPV4_RE, UUID_RE, ValidationError } from '../validation.js';

const FORGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'catalogue');
const CUSTOM_DIR = process.env.ANSIBLE_CATALOGUE_DIR || '/catalogue';
const FORGE_PREFIX = 'forge:';
export const OS_TYPES = ['linux', 'windows'];
const ID_RE = /^(forge:)?(linux|windows)\/([a-z0-9][a-z0-9_-]{0,62})$/;
const MAX_BRICK_CHARS = 64 * 1024;
const MAX_PARAMS = 30;
const MAX_TASKS = 100;
const MAX_DEPTH = 32;
const PARAM_RE = /^[a-z][a-z0-9_]{0,40}$/;
const PARAM_TYPES = ['str', 'int', 'float', 'bool', 'list', 'vault_entry', 'certificate_entry'];
const CERT_TYPES = ['cert_key', 'pkcs12', 'ca'];
const NUMBER_TYPES = ['int', 'float'];
const NUMBER_TEXT_RE = /^[+-]?\d{1,15}(?:[.,]\d{1,15})?$/;
const BRICK_KEYS = ['name', 'os', 'description', 'parameters', 'tasks'];
const PARAM_KEYS = ['label', 'help', 'type', 'required', 'default', 'choices', 'multiline', 'min', 'max', 'format', 'cert_types'];
const DNS_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const HOSTNAME_FORMAT_RE = new RegExp(`^${DNS_LABEL}$`);
const FQDN_RE = new RegExp(`^(?:${DNS_LABEL}\\.)+[a-zA-Z]{2,63}$`);
const WINDOWS_PATH_RE = /^(?:[a-zA-Z]:\\|\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+)[^/:*?"<>|]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(v) {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}

const PARAM_FORMATS = {
  ipv4: { label: 'adresse IPv4, ex. 192.168.1.10', test: (v) => IPV4_RE.test(v) },
  cidr: {
    label: 'réseau IPv4 avec masque, ex. 192.168.1.0/24',
    test: (v) => { const [ip, mask, ...rest] = v.split('/'); return !rest.length && IPV4_RE.test(ip) && CIDR_RE.test(mask ?? ''); },
  },
  hostname: { label: 'nom d\'hôte court, ex. srv-web01', test: (v) => HOSTNAME_FORMAT_RE.test(v) },
  fqdn: { label: 'nom DNS complet, ex. srv.exemple.lan', test: (v) => v.length <= 253 && FQDN_RE.test(v) },
  port: { label: 'port de 1 à 65535', test: (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 },
  path_linux: { label: 'chemin Linux absolu, ex. /etc/app.conf', test: (v) => v.startsWith('/') },
  path_windows: { label: 'chemin Windows absolu, ex. C:\\Data ou \\\\serveur\\partage', test: (v) => WINDOWS_PATH_RE.test(v) },
  url: { label: 'adresse http(s)://…', test: isHttpUrl },
  email: { label: 'adresse e-mail, ex. admin@exemple.lan', test: (v) => EMAIL_RE.test(v) },
};
const MODULE_PREFIXES = ['ansible.builtin.', 'ansible.posix.', 'community.general.', 'community.crypto.', 'ansible.windows.',
  'community.windows.', 'microsoft.ad.'];
const FORBIDDEN_KEYS = new Set(['hosts', 'become', 'become_user', 'become_method', 'become_flags', 'become_exe', 'vars_files',
  'import_playbook', 'roles']);
const TASK_KEYWORDS = new Set(['name', 'action', 'args', 'any_errors_fatal', 'async', 'changed_when', 'check_mode', 'collections',
  'connection', 'debugger', 'delay', 'delegate_facts', 'delegate_to', 'diff', 'environment', 'failed_when', 'ignore_errors',
  'ignore_unreachable', 'local_action', 'loop', 'loop_control', 'module_defaults', 'no_log', 'notify', 'poll', 'port', 'register',
  'remote_user', 'retries', 'run_once', 'tags', 'throttle', 'timeout', 'until', 'vars', 'when', 'block', 'rescue', 'always',
  'listen']);
const RESERVED_PARAMS = new Set([...TASK_KEYWORDS, ...FORBIDDEN_KEYS, 'item', 'omit', 'environment', 'hostvars', 'groups',
  'group_names', 'inventory_hostname', 'play_hosts', 'playbook_dir', 'role_path', 'gather_facts', 'tasks', 'handlers', 'lookup',
  'query', 'q', 'range', 'dict', 'true', 'false', 'none', 'and', 'or', 'not', 'in', 'is', 'if', 'else']);
const EXPRESSION_KEYS = new Set(['when', 'changed_when', 'failed_when', 'until']);
const JINJA_WORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'endif', 'for', 'endfor', 'set', 'endset',
  'with', 'endwith', 'raw', 'endraw', 'true', 'false', 'none', 'True', 'False', 'None', 'loop']);
const ANSIBLE_GLOBALS = new Set(['item', 'omit', 'hostvars', 'groups', 'group_names', 'inventory_hostname', 'inventory_hostname_short',
  'play_hosts', 'playbook_dir', 'role_path', 'ansible_loop', 'ansible_loop_var']);
const MULTILINE_MAX = 16000;
const LINE_MAX = 1000;
const LIST_MAX = 100;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const LINE_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f]/;
const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/;

export const isForgeBrick = (id) => String(id).startsWith(FORGE_PREFIX);

export function parseBrickId(id) {
  const m = ID_RE.exec(String(id || ''));
  if (!m) throw new ValidationError('Identifiant de brique invalide (linux/nom ou windows/nom, minuscules, chiffres, « - », « _ »)');
  return { forge: !!m[1], os: m[2], file: m[3], id: m[0] };
}

const brickPath = ({ forge, os, file }) => path.join(forge ? FORGE_DIR : CUSTOM_DIR, os, `${file}.yml`);

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeError = (where, message, details) => new ValidationError(`${where} : ${message}`, details);

const CONFLICT_DIRECTION = { BAD_INDENT: -1, MISSING_CHAR: -1, BLOCK_AS_IMPLICIT_KEY: 1 };

function conflictLines(text, line, code) {
  const lines = text.split('\n');
  const step = CONFLICT_DIRECTION[code];
  const meaningful = (n) => lines[n - 1].trim() && !lines[n - 1].trim().startsWith('#');
  let other = line;
  if (step) {
    for (let n = line + step; n >= 1 && n <= lines.length; n += step) {
      if (meaningful(n)) {
        other = n;
        break;
      }
    }
  }
  return { line: Math.min(line, other), lastLine: Math.max(line, other) };
}

function parseYaml(text, where) {
  if (typeof text !== 'string') throw typeError(where, 'texte YAML attendu');
  if (text.length > MAX_BRICK_CHARS) throw typeError(where, `trop long (${MAX_BRICK_CHARS} caractères max)`);
  const unsafe = UNSAFE_TEXT_CHARS.exec(text);
  if (unsafe) {
    const line = text.slice(0, unsafe.index).split('\n').length;
    throw typeError(where, `caractère interdit U+${unsafe[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} (ligne ${line}) : texte UTF-8 sans caractère de contrôle ni d'inversion de sens attendu`, { line });
  }
  const doc = parseDocument(text, { uniqueKeys: true, maxAliasCount: 0, prettyErrors: true });
  if (doc.errors.length) {
    const [err] = doc.errors;
    const { line, col } = err.linePos?.[0] || {};
    const reason = err.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    if (!line) throw typeError(where, `YAML invalide : ${reason}`);
    const lines = conflictLines(text, line, err.code);
    const place = lines.line === lines.lastLine ? `ligne ${line}, colonne ${col}` : `lignes ${lines.line} et ${lines.lastLine}`;
    throw typeError(where, `YAML invalide (${place}) : ${reason}`, lines);
  }
  try {
    return { data: doc.toJS({ maxAliasCount: 0 }), doc };
  } catch {
    throw typeError(where, 'ancres et alias YAML (& et *) non autorisés');
  }
}

function pathRange(doc, keys, keyOnly) {
  let node = doc.contents;
  let range = null;
  for (const [i, key] of keys.entries()) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
      if (!pair) break;
      const wholePair = isScalar(pair.value) && !(keyOnly && i === keys.length - 1);
      range = [pair.key.range[0], wholePair ? pair.value.range[1] : pair.key.range[1]];
      node = pair.value;
    } else if (isSeq(node) && node.items[key]) {
      node = node.items[key];
      range = [node.range[0], isScalar(node) ? node.range[1] : node.range[0]];
    } else {
      break;
    }
  }
  return range;
}

function errorLines(text, doc, { path: keys, word, keyOnly }) {
  const range = pathRange(doc, keys, keyOnly);
  if (!range) return {};
  const lines = text.split('\n');
  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  const first = lineAt(range[0]);
  let last = Math.max(first, lineAt(Math.max(range[0], range[1] - 1)));
  while (last > first && !lines[last - 1].trim()) last -= 1;
  if (word) {
    const pattern = new RegExp(`(^|[^\\w.])${word}(?!\\w)`);
    for (let n = first; n <= last; n += 1) if (pattern.test(lines[n - 1])) return { line: n, lastLine: n };
  }
  return { line: first, lastLine: last };
}

function stripLiterals(expr) {
  return expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ');
}

function expressionNames(expr) {
  const cleaned = stripLiterals(expr)
    .replace(/\|\s*[A-Za-z_]\w*/g, ' ')
    .replace(/\bis\s+(not\s+)?[A-Za-z_]\w*/g, ' ')
    .replace(/\b[A-Za-z_]\w*\s*=(?!=)/g, ' ');
  const names = [];
  const re = /(^|[^.\w])([A-Za-z_]\w*)(\s*\()?/g;
  let m;
  while ((m = re.exec(cleaned))) {
    if (!m[3] && !JINJA_WORDS.has(m[2])) names.push(m[2]);
  }
  return names;
}

function templateNames(text) {
  const names = [];
  for (const m of String(text).matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g)) names.push(...expressionNames(m[1] ?? m[2]));
  return names;
}

const nameUses = (names, path) => names.map((name) => ({ name, path }));

function collectNames(value, out, path, depth = 0) {
  if (depth > MAX_DEPTH) throw new ValidationError('Tâches : imbrication trop profonde');
  if (typeof value === 'string') out.push(...nameUses(templateNames(value), path));
  else if (Array.isArray(value)) value.forEach((v, i) => collectNames(v, out, [...path, i], depth + 1));
  else if (isMapping(value)) Object.entries(value).forEach(([k, v]) => collectNames(v, out, [...path, k], depth + 1));
}

function checkTasks(tasks, where, ctx, path, depth = 0) {
  if (!Array.isArray(tasks) || !tasks.length) throw typeError(where, 'liste de tâches non vide attendue', { path });
  if (depth > 8) throw typeError(where, 'blocs trop imbriqués', { path });
  tasks.forEach((task, i) => {
    const at = `${where}, tâche ${i + 1}`;
    const taskPath = [...path, i];
    const located = (key) => (key === undefined ? { path: taskPath } : { path: [...taskPath, key], keyOnly: true });
    if (!isMapping(task)) throw typeError(at, 'une tâche doit être un dictionnaire', located());
    ctx.count += 1;
    if (ctx.count > MAX_TASKS) throw typeError(where, `trop de tâches (${MAX_TASKS} max)`, located());
    const keys = Object.keys(task);
    const forbidden = keys.find((k) => FORBIDDEN_KEYS.has(k));
    if (forbidden) throw typeError(at, `« ${forbidden} » interdit dans une brique (c'est le profil qui le décide)`, located(forbidden));
    if (typeof task.register === 'string') ctx.registered.add(task.register);
    if (isMapping(task.loop_control) && typeof task.loop_control.loop_var === 'string') ctx.registered.add(task.loop_control.loop_var);
    const isBlock = ['block', 'rescue', 'always'].some((k) => k in task);
    if (isBlock) {
      for (const key of ['block', 'rescue', 'always']) {
        if (key === 'block' || key in task) checkTasks(task[key], `${at} (${key})`, ctx, [...taskPath, key], depth + 1);
      }
    } else {
      const modules = keys.filter((k) => !TASK_KEYWORDS.has(k) && !k.startsWith('with_'));
      if (modules.length !== 1) {
        throw typeError(at, modules.length ? `un seul module par tâche (${modules.join(', ')})` : 'module manquant', located(modules[1]));
      }
      const [module] = modules;
      if (!MODULE_PREFIXES.some((p) => module.startsWith(p) && module.length > p.length)) {
        throw typeError(at, `module « ${module} » non autorisé : nom complet attendu dans ${MODULE_PREFIXES.map((p) => `${p}*`).join(', ')}`, located(module));
      }
      if (module.endsWith('.set_fact') && isMapping(task[module])) Object.keys(task[module]).forEach((k) => ctx.registered.add(k));
      ctx.names.push(...nameUses(debugVarNames(module, task[module]), [...taskPath, module, 'var']));
    }
    for (const [key, value] of Object.entries(task)) {
      if (key === 'block' || key === 'rescue' || key === 'always') continue;
      if (EXPRESSION_KEYS.has(key)) {
        [].concat(value).forEach((v, n) => {
          if (typeof v === 'string') ctx.names.push(...nameUses(expressionNames(v.replace(/\{\{|\}\}/g, ' ')), Array.isArray(value) ? [...taskPath, key, n] : [...taskPath, key]));
        });
      } else if (key !== 'loop_control') {
        collectNames(value, ctx.names, [...taskPath, key]);
      }
    }
  });
}

const SECRET_KINDS = { vault_entry: 'vault', certificate_entry: 'cert' };
const PUBLIC_FIELDS = {
  vault: new Set(['username', 'public_key']),
  cert: new Set(['name', 'type', 'subject', 'issuer', 'not_after', 'thumbprint', 'fingerprint', 'certificate', 'chain', 'fullchain']),
  result: new Set(['rc', 'stdout', 'stdout_lines', 'stderr', 'stderr_lines', 'msg', 'output', 'error', 'changed', 'failed', 'skipped',
    'status', 'status_code', 'url', 'reboot_required']),
  fact: new Set(),
};
const NOT_DISPLAYED_KEYS = new Set(['block', 'rescue', 'always', 'name', 'loop_control', 'no_log', ...EXPRESSION_KEYS]);
const CONNECTION_SECRETS = ['ansible_password', 'ansible_pass', 'ansible_ssh_pass', 'ansible_become_password', 'ansible_become_pass',
  'ansible_winrm_password', 'hostvars'];
const LOOKUP_CALL_RE = /(?:^|[^.\w])(lookup|query|q)\s*\(/g;
const PUBLIC_ACCESS_RE = /^\s*\.\s*([A-Za-z_]\w*)/;
const TEST_RE = /^\s*is\s+(?:not\s+)?[A-Za-z_]\w*/;

function debugVarNames(module, args) {
  return module.endsWith('.debug') && isMapping(args) && typeof args.var === 'string' ? expressionNames(args.var) : [];
}

function secretUses(expr, secrets, out) {
  const cleaned = stripLiterals(expr);
  for (const call of cleaned.matchAll(LOOKUP_CALL_RE)) out.add(`${call[1]}()`);
  const re = /(^|[^.\w])([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const kind = secrets.get(m[2]);
    if (!kind) continue;
    const rest = cleaned.slice(m.index + m[0].length);
    const field = PUBLIC_ACCESS_RE.exec(rest);
    if (field ? PUBLIC_FIELDS[kind].has(field[1]) : TEST_RE.test(rest)) continue;
    out.add(field ? `${m[2]}.${field[1]}` : m[2]);
  }
}

function templateSecretUses(value, secrets, out, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g)) secretUses(m[1] ?? m[2], secrets, out);
  } else if (Array.isArray(value)) value.forEach((v) => templateSecretUses(v, secrets, out, depth + 1));
  else if (isMapping(value)) Object.values(value).forEach((v) => templateSecretUses(v, secrets, out, depth + 1));
}

function taskModule(task) {
  return Object.keys(task).find((k) => !TASK_KEYWORDS.has(k) && !k.startsWith('with_'));
}

function checkSecretTasks(tasks, where, secrets, path, hidden = false) {
  tasks.forEach((task, i) => {
    const at = `${where}, tâche ${i + 1}`;
    const taskPath = [...path, i];
    const quote = (names) => [...names].map((n) => `« ${n} »`).join(', ');
    const inName = new Set();
    templateSecretUses(task.name, secrets, inName);
    if (inName.size) throw typeError(at, `${quote(inName)} dans le nom de la tâche : le nom est affiché même avec « no_log: true », n'y mettre aucun secret`, { path: [...taskPath, 'name'] });
    const used = new Set();
    for (const [key, value] of Object.entries(task)) if (!NOT_DISPLAYED_KEYS.has(key)) templateSecretUses(value, secrets, used);
    const module = taskModule(task);
    if (module?.endsWith('.debug') && isMapping(task[module]) && typeof task[module].var === 'string') secretUses(task[module].var, secrets, used);
    const noLog = task.no_log === true || (hidden && task.no_log === undefined);
    if (used.size && !noLog) {
      throw typeError(at, `utilise ${quote(used)} (secret : coffre-fort, certificat, compte de connexion, lookup ou résultat qui en dépend) : « no_log: true » obligatoire sur la tâche ou son bloc`, { path: taskPath });
    }
    for (const key of ['block', 'rescue', 'always']) if (Array.isArray(task[key])) checkSecretTasks(task[key], `${at} (${key})`, secrets, [...taskPath, key], noLog);
    if (used.size) {
      if (typeof task.register === 'string') secrets.set(task.register, 'result');
      if (module?.endsWith('.set_fact') && isMapping(task[module])) Object.keys(task[module]).forEach((k) => secrets.set(k, 'fact'));
    }
  });
}

const choiceType = (type) => (type === 'list' ? 'str' : type);

function sameType(type, value) {
  if (type === 'str') return typeof value === 'string';
  if (type === 'int') return Number.isSafeInteger(value);
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'list') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  return false;
}

function checkParameters(parameters) {
  if (parameters === undefined || parameters === null) return [];
  const located = (...keys) => ({ path: ['parameters', ...keys] });
  const locatedKey = (...keys) => ({ ...located(...keys), keyOnly: true });
  if (!isMapping(parameters)) throw new ValidationError('parameters : dictionnaire attendu', located());
  const entries = Object.entries(parameters);
  if (entries.length > MAX_PARAMS) throw new ValidationError(`parameters : ${MAX_PARAMS} paramètres au plus`, located());
  return entries.map(([name, spec]) => {
    const at = `Paramètre « ${name} »`;
    const bad = (message, key) => typeError(at, message, key === undefined ? located(name) : located(name, key));
    const badKey = (message, key) => typeError(at, message, locatedKey(name, key));
    if (!PARAM_RE.test(name) || name.startsWith('ansible_') || name.startsWith('forge_') || RESERVED_PARAMS.has(name)) {
      throw bad('nom invalide ou réservé (minuscules, chiffres et « _ », sans préfixe ansible_ ni forge_)');
    }
    if (!isMapping(spec)) throw bad('dictionnaire attendu');
    const unknown = Object.keys(spec).find((k) => !PARAM_KEYS.includes(k));
    if (unknown) throw badKey(`clé inconnue « ${unknown} » (${PARAM_KEYS.join(', ')})`, unknown);
    if (typeof spec.label !== 'string' || !spec.label.trim()) throw bad('label obligatoire', 'label');
    if (spec.type === undefined) throw bad(`type obligatoire (${PARAM_TYPES.join(', ')})`);
    const { type } = spec;
    if (!PARAM_TYPES.includes(type)) throw bad(`type « ${type} » inconnu (${PARAM_TYPES.join(', ')})`, 'type');
    for (const key of ['label', 'help']) {
      if (spec[key] !== undefined && (typeof spec[key] !== 'string' || spec[key].length > 200)) throw bad(`${key} : texte de 200 caractères au plus`, key);
    }
    if (spec.required !== undefined && typeof spec.required !== 'boolean') throw bad('required : true ou false', 'required');
    if (spec.multiline !== undefined && (typeof spec.multiline !== 'boolean' || type !== 'str')) {
      throw bad('multiline : true ou false, seulement pour le type str', 'multiline');
    }
    let choices = null;
    if (spec.choices !== undefined) {
      if (!['str', 'int', 'float', 'list'].includes(type) || !Array.isArray(spec.choices) || !spec.choices.length || spec.choices.length > 50
        || !spec.choices.every((c) => sameType(choiceType(type), c)) || new Set(spec.choices).size !== spec.choices.length) {
        throw bad('choices : liste de valeurs distinctes du type du paramètre (str, int, float, ou textes pour list)', 'choices');
      }
      choices = spec.choices;
    }
    for (const key of ['min', 'max']) {
      if (spec[key] === undefined) continue;
      if (!NUMBER_TYPES.includes(type) || !sameType(type, spec[key])) throw bad(`${key} : nombre du type du paramètre, seulement pour int et float`, key);
      if (choices) throw bad(`${key} : inutile avec choices`, key);
    }
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) throw bad('min plus grand que max', 'min');
    let format = null;
    if (spec.format !== undefined) {
      if (!Object.hasOwn(PARAM_FORMATS, spec.format)) throw bad(`format « ${spec.format} » inconnu (${Object.keys(PARAM_FORMATS).join(', ')})`, 'format');
      if (!['str', 'list'].includes(type) || choices || spec.multiline) throw bad('format : seulement pour str (une ligne) ou list, sans choices', 'format');
      format = spec.format;
    }
    if (spec.default !== undefined && type === 'vault_entry') throw bad('pas de valeur par défaut pour une entrée du coffre', 'default');
    if (spec.default !== undefined && type === 'certificate_entry') throw bad('pas de valeur par défaut pour un certificat', 'default');
    let certTypes = null;
    if (spec.cert_types !== undefined) {
      if (type !== 'certificate_entry' || !Array.isArray(spec.cert_types) || !spec.cert_types.length
        || !spec.cert_types.every((t) => CERT_TYPES.includes(t)) || new Set(spec.cert_types).size !== spec.cert_types.length) {
        throw bad(`cert_types : liste parmi ${CERT_TYPES.join(', ')}, seulement pour le type certificate_entry`, 'cert_types');
      }
      certTypes = spec.cert_types;
    }
    if (spec.default !== undefined && !sameType(type, spec.default)) throw bad(`default : valeur de type ${type} attendue`, 'default');
    if (spec.default !== undefined) {
      const values = type === 'list' ? spec.default : [spec.default];
      if (choices && !values.every((d) => choices.includes(d))) throw bad('default : absent de choices', 'default');
      if (spec.min !== undefined && spec.default < spec.min) throw bad('default : inférieur à min', 'default');
      if (spec.max !== undefined && spec.default > spec.max) throw bad('default : supérieur à max', 'default');
      if (format && !values.every((d) => PARAM_FORMATS[format].test(d))) throw bad(`default : format ${format} attendu`, 'default');
    }
    return {
      name,
      label: spec.label.trim(),
      help: spec.help || '',
      type,
      required: spec.required === true,
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(choices ? { choices } : {}),
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(format ? { format, format_label: PARAM_FORMATS[format].label } : {}),
      ...(type === 'certificate_entry' ? { cert_types: certTypes || CERT_TYPES } : {}),
      multiline: spec.multiline === true,
    };
  });
}

export function brickNameOf(text) {
  try {
    const name = parseYaml(text, 'Brique').data?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export function checkBrickText(text, expectedOs) {
  const { data, doc } = parseYaml(text, 'Brique');
  try {
    return checkBrickData(data, expectedOs);
  } catch (e) {
    if (e instanceof ValidationError && e.details.path) e.details = errorLines(text, doc, e.details);
    throw e;
  }
}

function checkBrickData(data, expectedOs) {
  if (!isMapping(data)) throw new ValidationError('Brique : dictionnaire YAML attendu (name, os, description, parameters, tasks)');
  const unknown = Object.keys(data).find((k) => !BRICK_KEYS.includes(k));
  if (unknown) throw new ValidationError(`Brique : clé inconnue « ${unknown} » (${BRICK_KEYS.join(', ')})`, { path: [unknown], keyOnly: true });
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) throw new ValidationError('name : texte de 100 caractères au plus, obligatoire', { path: ['name'] });
  if (!OS_TYPES.includes(data.os)) throw new ValidationError('os : linux ou windows', { path: ['os'] });
  if (expectedOs && data.os !== expectedOs) throw new ValidationError(`os : « ${data.os} » dans le YAML, alors que le système choisi est « ${expectedOs} » : les deux doivent correspondre`, { path: ['os'] });
  if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 500)) {
    throw new ValidationError('description : texte de 500 caractères au plus', { path: ['description'] });
  }
  const parameters = checkParameters(data.parameters);
  const ctx = { count: 0, names: [], registered: new Set() };
  checkTasks(data.tasks, 'tasks', ctx, ['tasks']);
  const declared = new Set(parameters.map((p) => p.name));
  const undeclared = ctx.names.filter(({ name }) => !declared.has(name) && !ctx.registered.has(name) && !ANSIBLE_GLOBALS.has(name)
    && !name.startsWith('ansible_'));
  if (undeclared.length) {
    const names = [...new Set(undeclared.map((u) => u.name))];
    throw new ValidationError(`tasks : ${names.length > 1 ? 'variables non déclarées' : 'variable non déclarée'} dans parameters : ${names.join(', ')}`,
      { path: undeclared[0].path, word: undeclared[0].name });
  }
  checkSecretTasks(data.tasks, 'tasks', new Map([...CONNECTION_SECRETS.map((n) => [n, 'fact']),
    ...parameters.filter((p) => SECRET_KINDS[p.type]).map((p) => [p.name, SECRET_KINDS[p.type]])]), ['tasks']);
  return { name: data.name.trim(), os: data.os, description: data.description || '', parameters, tasks: data.tasks };
}

function readBrick(ref) {
  const file = brickPath(ref);
  const text = fs.readFileSync(file, 'utf8');
  const base = { id: ref.id, origin: ref.forge ? 'forge' : 'custom', os: ref.os, file: ref.file, yaml: text };
  try {
    return { ...base, ...checkBrickText(text, ref.os), error: null };
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return { ...base, name: ref.file, description: '', parameters: [], tasks: [], error: e.message };
  }
}

function listDir(forge) {
  const root = forge ? FORGE_DIR : CUSTOM_DIR;
  return OS_TYPES.flatMap((os) => {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, os));
    } catch (e) {
      if (forge && e.code !== 'ENOENT') throw e;
    }
    return names.filter((n) => n.endsWith('.yml')).map((n) => n.slice(0, -4)).sort()
      .flatMap((file) => {
        const id = `${forge ? FORGE_PREFIX : ''}${os}/${file}`;
        if (!ID_RE.test(id)) return [];
        try {
          return [readBrick(parseBrickId(id))];
        } catch (e) {
          return [{ id, origin: forge ? 'forge' : 'custom', os, file, yaml: '', name: file, description: '', parameters: [], tasks: [],
            error: `Lecture impossible : ${e.code || e.message}` }];
        }
      });
  });
}

export function catalogueStatus() {
  try {
    fs.accessSync(CUSTOM_DIR, fs.constants.R_OK | fs.constants.W_OK);
    return { dir: CUSTOM_DIR, writable: true };
  } catch (e) {
    return { dir: CUSTOM_DIR, writable: false, error: e.code === 'ENOENT' ? 'dossier absent' : 'droits insuffisants' };
  }
}

export const listBricks = () => [...listDir(true), ...listDir(false)];

export function getBrick(id) {
  const ref = parseBrickId(id);
  try {
    return readBrick(ref);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function customRef(id) {
  const ref = parseBrickId(id);
  if (ref.forge) throw new ValidationError('Brique Forge en lecture seule : la cloner pour la modifier');
  return ref;
}

function fsError(e, action) {
  if (e instanceof ValidationError) return e;
  if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) return new ValidationError(`${action} impossible : dossier du catalogue ${CUSTOM_DIR} non modifiable par Forge`);
  if (e.code === 'ENOENT') return new ValidationError(`${action} impossible : dossier du catalogue ${CUSTOM_DIR} absent`);
  return e;
}

export function createBrick(id, text) {
  const ref = customRef(id);
  checkBrickText(text, ref.os);
  const file = brickPath(ref);
  if (fs.existsSync(file)) throw new ValidationError(`La brique ${ref.id} existe déjà`);
  try {
    writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
  } catch (e) {
    throw fsError(e, 'Création');
  }
  return getBrick(ref.id);
}

export function updateBrick(id, newId, text) {
  const ref = customRef(id);
  const target = customRef(newId || id);
  if (target.os !== ref.os) throw new ValidationError('Le dossier OS d\'une brique ne change pas : la cloner');
  checkBrickText(text, target.os);
  const from = brickPath(ref);
  const to = brickPath(target);
  if (!fs.existsSync(from)) throw new ValidationError(`Brique ${ref.id} introuvable`);
  if (target.id !== ref.id && fs.existsSync(to)) throw new ValidationError(`La brique ${target.id} existe déjà`);
  try {
    writeAtomic(to, text.endsWith('\n') ? text : `${text}\n`);
    if (target.id !== ref.id) fs.rmSync(from, { force: true });
  } catch (e) {
    throw fsError(e, 'Enregistrement');
  }
  return getBrick(target.id);
}

export function removeBrick(id) {
  const ref = customRef(id);
  const file = brickPath(ref);
  if (!fs.existsSync(file)) throw new ValidationError(`Brique ${ref.id} introuvable`);
  try {
    fs.rmSync(file);
  } catch (e) {
    throw fsError(e, 'Suppression');
  }
}

export function cloneDraft(id) {
  const brick = getBrick(id);
  if (!brick) throw new ValidationError('Brique introuvable');
  const taken = new Set(listDir(false).map((b) => b.id));
  const base = `${brick.os}/${brick.file}`.slice(0, 60);
  let candidate = `${base}-copie`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-copie-${n}`;
  return { id: candidate, yaml: brick.yaml, copy_from: brick.id };
}

function cleanString(value, param, at) {
  if (typeof value !== 'string') throw typeError(at, 'texte attendu');
  const v = param.multiline ? value.replace(/\r\n?/g, '\n') : value.trim();
  if (v.length > (param.multiline ? MULTILINE_MAX : LINE_MAX)) throw typeError(at, 'trop long');
  if ((param.multiline ? CONTROL_CHARS : LINE_CONTROL_CHARS).test(v)) throw typeError(at, 'caractères interdits');
  return param.multiline ? v.replace(/\s+$/, '') : v;
}

function checkFormat(param, values, at) {
  if (!param.format) return;
  const bad = values.find((v) => !PARAM_FORMATS[param.format].test(v));
  if (bad !== undefined) throw typeError(at, `« ${bad.length > 60 ? `${bad.slice(0, 57)}…` : bad} » : ${PARAM_FORMATS[param.format].label} attendu`);
}

function cleanValue(param, raw, at) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()) || (Array.isArray(raw) && !raw.length);
  if (empty) {
    if (param.required) throw typeError(at, 'obligatoire');
    return param.default;
  }
  switch (param.type) {
    case 'bool':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw typeError(at, 'oui ou non attendu');
    case 'int':
    case 'float': {
      const textual = String(raw).trim();
      const n = typeof raw === 'number' ? raw : NUMBER_TEXT_RE.test(textual) ? Number(textual.replace(',', '.')) : NaN;
      if (!sameType(param.type, n)) throw typeError(at, param.type === 'int' ? 'nombre entier attendu' : 'nombre attendu');
      if (param.choices && !param.choices.includes(n)) throw typeError(at, 'valeur hors de la liste');
      if (param.min !== undefined && n < param.min) throw typeError(at, `${param.min} au minimum`);
      if (param.max !== undefined && n > param.max) throw typeError(at, `${param.max} au maximum`);
      return n;
    }
    case 'list': {
      const items = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => cleanString(String(x), { multiline: false }, at)).filter(Boolean);
      if (items.length > LIST_MAX) throw typeError(at, `${LIST_MAX} éléments au plus`);
      if (param.required && !items.length) throw typeError(at, 'obligatoire');
      const outside = param.choices && items.find((x) => !param.choices.includes(x));
      if (outside) throw typeError(at, `« ${outside} » hors de la liste`);
      checkFormat(param, items, at);
      if (param.choices?.includes('*') && items.includes('*')) return ['*'];
      return param.choices ? param.choices.filter((c) => items.includes(c)) : items;
    }
    case 'vault_entry':
      if (!UUID_RE.test(String(raw))) throw typeError(at, 'entrée du coffre-fort invalide');
      return String(raw);
    case 'certificate_entry':
      if (!UUID_RE.test(String(raw))) throw typeError(at, 'certificat invalide');
      return String(raw);
    default: {
      const v = cleanString(raw, param, at);
      if (!v && param.required) throw typeError(at, 'obligatoire');
      if (param.choices && !param.choices.includes(v)) throw typeError(at, 'valeur hors de la liste');
      if (v) checkFormat(param, [v], at);
      return v || param.default;
    }
  }
}

export function checkStepValues(brick, values, where) {
  if (values !== undefined && !isMapping(values)) throw typeError(where, 'valeurs attendues sous forme de dictionnaire');
  const out = {};
  for (const param of brick.parameters) {
    const v = cleanValue(param, values?.[param.name], `${where}, ${param.label}`);
    if (v !== undefined) out[param.name] = v;
  }
  return out;
}

export function resolveStepBrick(step, os, where) {
  const brick = getBrick(step.brick);
  if (!brick) throw typeError(where, `brique ${step.brick} introuvable dans le catalogue`);
  if (brick.error) throw typeError(where, `brique ${step.brick} invalide : ${brick.error}`);
  if (brick.os !== os) throw typeError(where, `brique ${step.brick} prévue pour ${brick.os}`);
  return brick;
}
