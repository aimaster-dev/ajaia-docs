import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is built into Node (no native add-on) and is memory-hard, which makes
// offline guessing expensive if the database ever leaks. ~50 ms per hash.
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, opts: ScryptOptions, keyLength = KEY_LENGTH): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Returns a self-describing hash: `scrypt$N$r$p$salt$key` (base64). Storing the
 * parameters with the hash means they can be raised later without breaking
 * existing passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Reject anything malformed (or absurdly expensive) instead of throwing.
  const sane = scheme === 'scrypt' && Number.isInteger(N) && N >= 1024 && N <= 1 << 20 && (N & (N - 1)) === 0;
  if (!sane || !(R >= 1 && R <= 32) || !(P >= 1 && P <= 16) || !saltB64 || !keyB64) return false;

  const expected = Buffer.from(keyB64, 'base64');
  if (expected.length < 16) return false;
  const actual = await derive(password, Buffer.from(saltB64, 'base64'), { N, r: R, p: P, maxmem: 256 * N * R }, expected.length);
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU time as a real check, so "no such user" and "wrong
 * password" take equally long and response timing doesn't reveal which
 * usernames exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
  return false;
}
