import { getSetting, setSetting } from './db.js';
import { ValidationError } from './validation.js';

const KEY = 'log_colors';

export const getLogColors = async () => (await getSetting(KEY)) === 'true';

export async function setLogColors(value) {
  if (typeof value !== 'boolean') throw new ValidationError('Valeur booléenne attendue');
  await setSetting(KEY, String(value));
  return getLogColors();
}

export const jobLogColors = () => getLogColors().catch(() => false);
