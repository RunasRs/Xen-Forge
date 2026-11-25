export const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  return `${date.toLocaleDateString('fr-FR')} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};

export function timeAgo(d) {
  const min = Math.round((Date.now() - new Date(d)) / 60000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days > 30) return new Date(d).toLocaleDateString('fr-FR');
  return days === 1 ? 'hier' : `il y a ${days} j`;
}

export function shortDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds} s`;
  const min = Math.round(seconds / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

export function duration(j) {
  if (!j.started_at) return '—';
  return shortDuration(Math.round(((j.finished_at ? new Date(j.finished_at) : new Date()) - new Date(j.started_at)) / 1000));
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export const countLabel = (st, total, one, many) => (st.search ? plural(total, 'résultat') : plural(total, one, many));
