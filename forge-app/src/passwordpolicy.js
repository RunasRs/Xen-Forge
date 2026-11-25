import { getSetting, setSetting } from './db.js';
import { ValidationError } from './validation.js';

const KEYS = { minLength: 'password_min_length', complexity: 'password_complexity' };
const LENGTH = { min: 12, max: 64, default: 12 };
const REQUIRED_CLASSES = { none: 0, three: 3, four: 4 };
const CHARACTER_CLASSES = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{N}]/u];
const PASSWORD_MAX_LENGTH = 256;

const validLength = (n) => Number.isInteger(n) && n >= LENGTH.min && n <= LENGTH.max;
const validComplexity = (c) => typeof c === 'string' && Object.hasOwn(REQUIRED_CLASSES, c);

export async function getPasswordPolicy() {
  const [length, complexity] = await Promise.all([getSetting(KEYS.minLength), getSetting(KEYS.complexity)]);
  const n = length == null || length === '' ? NaN : Number(length);
  return { minLength: validLength(n) ? n : LENGTH.default, complexity: validComplexity(complexity) ? complexity : 'none' };
}

export async function setPasswordPolicy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Politique de mot de passe invalide');
  const hasLength = 'minLength' in body;
  const hasComplexity = 'complexity' in body;
  if (hasLength && !validLength(body.minLength)) {
    throw new ValidationError(`Longueur minimale : nombre entier entre ${LENGTH.min} et ${LENGTH.max}`);
  }
  if (hasComplexity && !validComplexity(body.complexity)) throw new ValidationError('Complexité : valeur inconnue');
  if (hasLength) await setSetting(KEYS.minLength, String(body.minLength));
  if (hasComplexity) await setSetting(KEYS.complexity, body.complexity);
  return getPasswordPolicy();
}

const classCount = (password) => CHARACTER_CLASSES.filter((re) => re.test(password)).length;

export function passwordProblem(password, policy, username) {
  if (typeof password !== 'string') return 'Mot de passe requis';
  if ([...password].length < policy.minLength) return `Mot de passe : ${policy.minLength} caractères minimum`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Mot de passe trop long (${PASSWORD_MAX_LENGTH} caractères max)`;
  const required = REQUIRED_CLASSES[policy.complexity] || 0;
  if (classCount(password) < required) {
    return required === 4
      ? 'Mot de passe : minuscules, majuscules, chiffres et caractères spéciaux requis'
      : 'Mot de passe : au moins 3 types parmi minuscules, majuscules, chiffres et caractères spéciaux';
  }
  if (username != null && password.toLowerCase() === String(username).toLowerCase()) {
    return 'Le mot de passe ne doit pas être l\'identifiant';
  }
  return null;
}
