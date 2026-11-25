import { getSetting, setSetting } from './db.js';
import { ValidationError } from './validation.js';

const KEY = 'packer_command_trace';

export async function getCommandTrace() {
  return { packerLinux: await getSetting(KEY) === 'true' };
}

export async function setCommandTrace(body = {}) {
  if (!('packerLinux' in body)) return getCommandTrace();
  if (typeof body.packerLinux !== 'boolean') throw new ValidationError('Valeur booléenne attendue');
  await setSetting(KEY, String(body.packerLinux));
  return getCommandTrace();
}

export const jobCommandTrace = () => getCommandTrace().then((s) => s.packerLinux).catch(() => false);
