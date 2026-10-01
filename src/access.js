// Per-link passwords: scrypt hashes at rest, and a signed cookie once a viewer has typed the password.

import crypto from 'node:crypto';

const KEYLEN = 32;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('base64url')}:${crypto.scryptSync(password, salt, KEYLEN).toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), KEYLEN);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'base64url'));
}

// The cookie value is bound to the current hash, so changing (or removing) a password signs everyone out.
export function accessToken(secret, share) {
  return crypto.createHmac('sha256', secret).update(`${share.id}:${share.password_hash}`).digest('base64url');
}

export function tokenMatches(token, expected) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Wrong-password throttle: after `max` failures for the same link from the same address, wait `windowMs`.
export function createLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map(); // key -> { count, since }
  const live = (key) => {
    const f = fails.get(key);
    if (f && Date.now() - f.since > windowMs) fails.delete(key);
    return fails.get(key);
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= max,
    fail(key) {
      const f = live(key) || { count: 0, since: Date.now() };
      f.count += 1;
      fails.set(key, f);
      if (fails.size > 10000) fails.delete(fails.keys().next().value);
    },
    clear: (key) => fails.delete(key),
  };
}
