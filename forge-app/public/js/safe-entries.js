export const isAccountEntry = (e) => e.type !== 'product_key';

const safeEntryLabel = (e) => (e.username ? `${e.name} (${e.username})` : e.name);

const SAFE_ENTRY_TYPES = { password: 'mot de passe', ssh_key: 'Clé SSH' };

export const safeEntryOption = (e) => ({ value: e.id, name: safeEntryLabel(e), meta: SAFE_ENTRY_TYPES[e.type] || '' });
