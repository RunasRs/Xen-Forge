import { pool } from './db.js';

const OS_FAMILIES = {
  almalinux: 'almalinux',
  rocky: 'rocky',
  oracle: 'oracle',
  fedora: 'fedora',
  ubuntu: 'ubuntu',
  debian: 'debian',
  kali: 'kali',
  opensuse: 'opensuse',
  windows: 'windows',
};

export const CATALOG_OS = Object.keys(OS_FAMILIES);

export const EL_FAMILIES = new Set(['almalinux', 'fedora', 'oracle', 'rocky']);

const majorFromVersion = (os, version) => {
  const m = String(version).slice(String(os).length).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

const URL_FAMILY_RULES = [
  [/microsoft\.com/, 'windows'],
  [/almalinux\.org/, 'almalinux'],
  [/rockylinux\.org/, 'rocky'],
  [/yum\.oracle\.com/, 'oracle'],
  [/fedoraproject\.org/, 'fedora'],
  [/releases\.ubuntu\.com/, 'ubuntu'],
  [/cdimage\.debian\.org/, 'debian'],
  [/cdimage\.kali\.org/, 'kali'],
  [/opensuse\.org/, 'opensuse'],
];

function familyOfUrl(isoUrl = '', osType = '') {
  if (osType === 'windows') return 'windows';
  const url = String(isoUrl || '');
  const rule = URL_FAMILY_RULES.find(([re]) => re.test(url));
  if (!rule) throw new Error(`ISO non reconnue : ${url} n'est ni au catalogue ni sur un site de distribution connu`);
  return rule[1];
}

function rhelMajorOfUrl(isoUrl = '') {
  const m = String(isoUrl || '').match(/almalinux\/(\d+)|pub\/rocky\/(\d+)|OL(\d+)\/|releases\/(\d+)/);
  for (const g of m?.slice(1) || []) if (g) return Number(g);
  return 9;
}

async function resolveOs(isoUrl = '', osType = '') {
  const { rows } = await pool.query('SELECT os, version FROM distribution WHERE url = $1', [String(isoUrl || '')]);
  const row = rows[0];
  if (row && OS_FAMILIES[row.os]) {
    const family = OS_FAMILIES[row.os];
    return {
      family,
      osMajor: EL_FAMILIES.has(family) ? (majorFromVersion(row.os, row.version) ?? rhelMajorOfUrl(isoUrl)) : null,
    };
  }
  const family = familyOfUrl(isoUrl, osType);
  return { family, osMajor: EL_FAMILIES.has(family) ? rhelMajorOfUrl(isoUrl) : null };
}

const LEAP_AGAMA_RE = /download\.opensuse\.org\/distribution\/leap\/16\.\d+\/installer\/iso\/agama-installer\.x86_64-[^/]*\.iso$/;

function opensuseSource(isoUrl = '') {
  const url = String(isoUrl || '');
  if (LEAP_AGAMA_RE.test(url)) return { family: 'opensuse_agama' };
  const m = url.match(/download\.opensuse\.org\/distribution\/leap\/(15\.\d+)\/iso\/[^/]*-NET-x86_64(?:-[^/]*)?\.iso$/);
  if (!m) {
    throw new Error('ISO openSUSE non prise en charge : ISO NET x86_64 de Leap 15 (…/leap/15.x/iso/…-NET-x86_64…iso) '
      + 'ou ISO Agama x86_64 de Leap 16 (…/leap/16.x/installer/iso/agama-installer.x86_64-…iso) attendue');
  }
  return { family: 'opensuse', installRepo: `https://download.opensuse.org/distribution/leap/${m[1]}/repo/oss/` };
}

const KICKSTART_NETINST_SOURCES = [
  {
    re: /almalinux\.org\/almalinux\/(\d+)\/isos\//,
    repos: (m) => {
      const base = `https://repo.almalinux.org/almalinux/${m[1]}`;
      return { url: `${base}/BaseOS/x86_64/os/`, extra: [`repo --name=appstream --baseurl=${base}/AppStream/x86_64/os/`] };
    },
  },
  {
    re: /rockylinux\.org\/pub\/rocky\/(\d+)\/isos\//,
    repos: (m) => {
      const base = `https://download.rockylinux.org/pub/rocky/${m[1]}`;
      return { url: `${base}/BaseOS/x86_64/os/`, extra: [`repo --name=appstream --baseurl=${base}/AppStream/x86_64/os/`] };
    },
  },
  {
    re: /yum\.oracle\.com\/ISOS\/OracleLinux\/OL(\d+)\//i,
    repos: (m) => {
      const base = `https://yum.oracle.com/repo/OracleLinux/OL${m[1]}`;
      return { url: `${base}/baseos/latest/x86_64/`, extra: [`repo --name=appstream --baseurl=${base}/appstream/x86_64/`] };
    },
  },
  {
    re: /fedoraproject\.org\/pub\/fedora\/linux\/releases\/(\d+)\/Server\//,
    repos: (m) => ({
      mirrorlist: `https://mirrors.fedoraproject.org/mirrorlist?repo=fedora-${m[1]}&arch=x86_64`,
      extra: [],
    }),
  },
];

export function kickstartSource(isoUrl = '') {
  const url = String(isoUrl || '');
  if (!/(boot\.iso|netinst|minimal)/i.test(url)) return null;
  for (const s of KICKSTART_NETINST_SOURCES) {
    const m = url.match(s.re);
    if (m) {
      const src = s.repos(m);
      return { url: src.url, mirrorlist: src.mirrorlist, repos: src.extra };
    }
  }
  throw new Error('ISO netinst sans dépôt réseau connu pour cette distribution : utiliser une ISO complète (DVD)');
}

async function resolveLatestIsoChecksum(isoUrl = '', stored = '') {
  const url = String(isoUrl || '');
  const file = url.split('/').pop() || '';
  if (!/-latest-/i.test(file)) return String(stored || '');
  try {
    const base = url.slice(0, url.length - file.length);
    const res = await fetch(`${base}CHECKSUM`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return String(stored || '');
    const text = await res.text();
    const re = /^SHA256 \(([^)]+)\) = ([0-9a-f]{64})$/gim;
    for (let m; (m = re.exec(text));) {
      if (m[1] === file) return `sha256:${m[2]}`;
    }
    return String(stored || '');
  } catch {
    return String(stored || '');
  }
}

export async function normalizeVars(input = {}) {
  const vars = { ...input };
  const { family, osMajor } = await resolveOs(vars.iso_url, vars.os_type);
  vars.os_family = family;
  if (EL_FAMILIES.has(family)) vars.os_major = String(osMajor ?? 9);
  if (family === 'opensuse') {
    const suse = opensuseSource(vars.iso_url);
    vars.os_family = suse.family;
    if (suse.installRepo) vars.install_repo = suse.installRepo;
  }
  vars.iso_checksum = await resolveLatestIsoChecksum(vars.iso_url, vars.iso_checksum);
  return vars;
}
