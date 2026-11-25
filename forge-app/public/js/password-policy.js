export const COMPLEXITY_LABELS = { none: 'Aucune', three: '3 types sur 4', four: '4 types sur 4' };

const COMPLEXITY_RULES = {
  three: '3 types parmi minuscules, majuscules, chiffres et caractères spéciaux',
  four: 'minuscules, majuscules, chiffres et caractères spéciaux',
};

export const policySummary = (policy) => [`${policy.minLength} caractères minimum`, COMPLEXITY_RULES[policy.complexity]]
  .filter(Boolean).join(' ; ').concat('.');
