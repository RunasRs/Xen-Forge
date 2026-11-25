import fs from 'node:fs';
import path from 'node:path';
import * as agama from './agama.js';
import * as autoinstall from './autoinstall.js';
import * as autounattend from './autounattend.js';
import * as autoyast from './autoyast.js';
import * as kickstart from './kickstart.js';
import * as preseed from './preseed.js';
import { linuxProfileScript } from './common.js';

const LINUX = { linux: true, scripts: ({ vars }) => ({ 'scripts/linux/30-profile.sh': linuxProfileScript(vars) }) };
const KICKSTART = { ...LINUX, answerFile: 'ks.cfg', label: 'Kickstart (ks.cfg)', build: kickstart.build };
const PRESEED = { ...LINUX, answerFile: 'preseed.cfg', label: 'Preseed (preseed.cfg)' };

const FAMILIES = {
  ubuntu: { ...LINUX, answerFile: 'user-data', label: 'Autoinstall (user-data)', build: autoinstall.build,
    scripts: (ctx) => ({ ...LINUX.scripts(ctx), 'http/meta-data': '' }) },
  almalinux: KICKSTART,
  fedora: KICKSTART,
  oracle: KICKSTART,
  rocky: KICKSTART,
  debian: { ...PRESEED, build: preseed.buildDebian },
  kali: { ...PRESEED, build: preseed.buildKali },
  opensuse: { ...LINUX, answerFile: 'autoinst.xml', label: 'AutoYaST (autoinst.xml)', build: autoyast.build },
  opensuse_agama: { ...LINUX, answerFile: 'profile.json', label: 'Agama (profile.json)', build: agama.build },
  windows: { answerDir: 'cd', answerFile: 'autounattend.xml', label: 'Autounattend (autounattend.xml)', passwordOnly: true, build: autounattend.build, scripts: autounattend.scripts },
};

function familySpec(family) {
  const spec = FAMILIES[family];
  if (!spec) throw new Error(`Famille d'OS inconnue : ${family}`);
  return { answerDir: 'http', ...spec, recipe: `${family}.pkr.hcl` };
}

export const usesBuildHttp = (family) => familySpec(family).answerDir === 'http';

const OS_UPDATE_BLOCK = /^[ \t]*# os_update:begin\n[\s\S]*?^[ \t]*# os_update:end\n/gm;

export function prepareRecipe(srcDir, dstDir, ctx) {
  const spec = familySpec(ctx.vars.os_family);
  fs.mkdirSync(path.join(dstDir, spec.answerDir), { recursive: true });
  fs.copyFileSync(path.join(srcDir, 'plugins.pkr.hcl'), path.join(dstDir, 'plugins.pkr.hcl'));
  fs.copyFileSync(path.join(srcDir, 'variables.pkr.hcl'), path.join(dstDir, 'variables.pkr.hcl'));
  const recipe = fs.readFileSync(path.join(srcDir, spec.recipe), 'utf8');
  fs.writeFileSync(path.join(dstDir, spec.recipe),
    String(ctx.vars.os_update) === 'true' ? recipe : recipe.replace(OS_UPDATE_BLOCK, ''));
  fs.symlinkSync(process.env.VENDOR_DIR || '/opt/vendor', path.join(dstDir, 'vendor'));
  if (spec.linux) {
    fs.mkdirSync(path.join(dstDir, 'scripts', 'linux'), { recursive: true });
    for (const name of fs.readdirSync(path.join(srcDir, 'scripts', 'linux'))) {
      fs.copyFileSync(path.join(srcDir, 'scripts', 'linux', name), path.join(dstDir, 'scripts', 'linux', name));
    }
  }
  fs.writeFileSync(path.join(dstDir, spec.answerDir, spec.answerFile), spec.build(ctx), { mode: 0o600 });
  for (const [name, content] of Object.entries(spec.scripts?.(ctx) || {})) {
    fs.mkdirSync(path.dirname(path.join(dstDir, name)), { recursive: true });
    fs.writeFileSync(path.join(dstDir, name), content, { mode: 0o600 });
  }
  return spec;
}
