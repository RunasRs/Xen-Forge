export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.status = 400;
    this.details = details;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV4_CORE = IPV4_RE.source.slice(1, -1);
export const DNS_LIST_RE = new RegExp(`^${IPV4_CORE}(,\\s*${IPV4_CORE}){0,3}$`);
export const CIDR_RE = /^(3[0-2]|[12]?\d)$/;
export const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})(\.[a-zA-Z0-9-]{1,63}){0,4}$/;
const HOSTNAME_CORE = HOSTNAME_RE.source.slice(1, -1);
export const NTP_LIST_RE = new RegExp(`^${HOSTNAME_CORE}(,\\s*${HOSTNAME_CORE}){0,3}$`);
export const TIMEZONE_RE = /^[\w/+.-]{1,64}$/;
export const LOCALE_RE = /^[\w@.+-]{2,32}$/;
export const KEYBOARD_RE = /^\w{1,8}$/;
export const PACKAGES_RE = /^[\w.+-]+(,\s*[\w.+-]+){0,49}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

const HOST_PORT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252})(:(\d{1,5}))?$/;
export function normalizeHost(raw, label) {
  const host = String(raw || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = host.match(HOST_PORT_RE);
  if (!m || (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535))) {
    throw new ValidationError(`${label} : adresse invalide (IP ou FQDN, port optionnel)`);
  }
  return host;
}
export function splitHost(host) {
  const [hostname, port] = String(host).split(':');
  return { hostname, port: Number(port) || 443 };
}

export const XCP_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ ().-]{0,127}$/u;
export const TAGS_RE = /^[^,\p{Cc}]{1,64}(,[^,\p{Cc}]{1,64}){0,49}$/u;
export const TAGS_MAX_LENGTH = 50 * 64 + 49;

export function requireSafeEntry(vars) {
  if (!vars.safe_entry_id) throw new ValidationError('Entrée du coffre-fort obligatoire');
}

export const isBannedKey = (key) => /^(__proto__|constructor|prototype)$/.test(key);

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);

function sameSubnet(a, b, cidr) {
  const bits = Number(cidr);
  if (bits === 0) return true;
  const mask = 2 ** 32 - 2 ** (32 - bits);
  return ((ipToInt(a) & mask) >>> 0) === ((ipToInt(b) & mask) >>> 0);
}

export function checkField(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === undefined || v === null || v === '') return null;
  if (field.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n) || (field.min != null && n < field.min) || (field.max != null && n > field.max)) {
      throw new ValidationError(`${field.label} : entier entre ${field.min ?? '-∞'} et ${field.max ?? '+∞'} attendu`);
    }
    return n;
  }
  const s = String(v);
  if (field.type === 'select' && !field.options.some((o) => o.value === s)) {
    throw new ValidationError(`${field.label} : valeur invalide (${field.options.map((o) => o.value).join(', ')})`);
  }
  if (s.length > (field.maxLength || 255) || CONTROL_CHARS.test(s)) throw new ValidationError(`${field.label} : valeur invalide`);
  if (field.type === 'url' && !/^https?:\/\/\S+$/.test(s)) throw new ValidationError(`${field.label} : URL http(s) attendue`);
  if (field.re && !field.re.test(s)) throw new ValidationError(`${field.label} : format invalide`);
  return s;
}

export function checkFields(fields, input) {
  const vars = {};
  for (const f of fields) {
    const val = checkField(f, input[f.key]);
    if (val !== null) vars[f.key] = val;
    else if (f.default !== undefined) vars[f.key] = f.default;
    else if (f.required) throw new ValidationError(`${f.label} : champ obligatoire`);
  }
  return vars;
}

export function checkRequiredField(field, raw) {
  const value = checkField(field, raw);
  if (value === null) throw new ValidationError(`${field.label} obligatoire`);
  return value;
}

export function checkExtra(key, spec, value) {
  if (typeof value !== 'string') throw new ValidationError(`${key} : chaîne attendue`);
  const v = value.replace(/\r/g, '').trim();
  if (v === '') return '';
  if (spec.lines) {
    if (v.length > spec.max) throw new ValidationError(`${key} : trop long (max ${spec.max})`);
    const items = v.split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = items.find((l) => !spec.lines.test(l));
    if (bad) throw new ValidationError(`${key} : ligne invalide « ${bad.slice(0, 40)}… »`);
    return items.join('\n');
  }
  const max = spec.text?.max || 500;
  if (v.length > max) throw new ValidationError(`${key} : trop long (max ${max})`);
  if (spec.text?.lines && v.split('\n').length > spec.text.lines) {
    throw new ValidationError(`${key} : trop de lignes (max ${spec.text.lines})`);
  }
  if (CONTROL_CHARS.test(v)) throw new ValidationError(`${key} : caractères interdits`);
  if (spec.re && !spec.re.test(v)) throw new ValidationError(`${key} : format invalide`);
  return v;
}

export function splitStaticAddress(input) {
  const raw = typeof input.network_static_ip === 'string' ? input.network_static_ip.trim() : '';
  const { network_cidr: _cidr, ...rest } = input;
  if (!raw) return rest;
  const m = raw.match(/^([^/\s]+)\/(\d{1,2})$/);
  const where = '(onglet Configuration OS, Réseau)';
  if (!m) throw new ValidationError(`Adresse IP : format IP/CIDR attendu, par exemple 192.168.1.10/24 ${where}`);
  if (!IPV4_RE.test(m[1])) throw new ValidationError(`Adresse IP : « ${m[1]} » n'est pas une adresse IPv4 valide ${where}`);
  if (!CIDR_RE.test(m[2])) throw new ValidationError(`Adresse IP : préfixe /${m[2]} invalide, de /0 à /32 ${where}`);
  return { ...rest, network_static_ip: m[1], network_cidr: m[2] };
}

export function checkStaticNetwork(vars) {
  if (!vars.network_cidr) throw new ValidationError('CIDR obligatoire en IP fixe (onglet Configuration OS, Réseau)');
  if (vars.network_gateway && !sameSubnet(vars.network_static_ip, vars.network_gateway, vars.network_cidr)) {
    throw new ValidationError(`Passerelle ${vars.network_gateway} hors du réseau ${vars.network_static_ip}/${vars.network_cidr}`);
  }
}
