const PAIR_THRESHOLD = 5;
const PAIR_MAX_LOCK_MS = 60 * 60 * 1000;
const ACCOUNT_THRESHOLD = 10;
const ACCOUNT_MAX_DELAY_MS = 30 * 1000;
const RETENTION_MS = 24 * 3600 * 1000;

const backoff = (count, threshold, unitMs, maxMs) =>
  (count < threshold ? 0 : Math.min(unitMs * 2 ** (count - threshold), maxMs));

export function createLoginGuard({ now = Date.now } = {}) {
  const failures = new Map();
  const pairKey = (ip, account) => `pair|${ip}|${String(account).toLowerCase()}`;
  const accountKey = (account) => `account|${String(account).toLowerCase()}`;

  const remaining = (key, waitMs) => {
    const entry = failures.get(key);
    if (!entry) return 0;
    const left = entry.at + waitMs(entry.count) - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  };
  const count = (key) => failures.set(key, { count: (failures.get(key)?.count || 0) + 1, at: now() });

  return {
    retryAfter(ip, account) {
      return Math.max(
        remaining(pairKey(ip, account), (n) => backoff(n, PAIR_THRESHOLD, 60 * 1000, PAIR_MAX_LOCK_MS)),
        remaining(accountKey(account), (n) => backoff(n, ACCOUNT_THRESHOLD, 1000, ACCOUNT_MAX_DELAY_MS)));
    },
    recordFailure(ip, account) {
      count(pairKey(ip, account));
      count(accountKey(account));
    },
    recordSuccess(ip, account) {
      failures.delete(pairKey(ip, account));
      failures.delete(accountKey(account));
    },
    purge() {
      for (const [key, entry] of failures) if (now() - entry.at >= RETENTION_MS) failures.delete(key);
    },
  };
}
