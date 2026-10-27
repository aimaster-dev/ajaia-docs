// Client-side checks that mirror the server's rules, so people see problems
// before submitting. The server validates again; these are only for speed.
import {
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_HINT,
  USERNAME_PATTERN,
  normalizeUsername,
} from '../../shared/types.js';

export type Errors<K extends string> = Partial<Record<K | 'form', string>>;

export function checkName(name: string): string | undefined {
  if (!name.trim()) return 'Enter your name.';
  if (name.trim().length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
}

export function checkUsername(raw: string): string | undefined {
  const u = normalizeUsername(raw);
  if (!u) return 'Choose a username.';
  if (u.length < MIN_USERNAME_LENGTH) return `Username must be at least ${MIN_USERNAME_LENGTH} characters.`;
  if (u.length > MAX_USERNAME_LENGTH) return `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`;
  if (!USERNAME_PATTERN.test(u)) return `${USERNAME_HINT} It must start and end with a letter or number.`;
}

export function checkNewPassword(password: string, username?: string): string | undefined {
  if (!password) return 'Choose a password.';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  if (!password.trim()) return 'Password can’t be only spaces.';
  if (username && password.toLowerCase() === normalizeUsername(username)) {
    return 'Password can’t be the same as your username.';
  }
}

export function checkConfirm(password: string, confirm: string): string | undefined {
  if (!confirm) return 'Type the password again.';
  if (confirm !== password) return 'Passwords don’t match.';
}

/** Drops undefined entries so `Object.keys(errors).length` means "has errors". */
export function compact<K extends string>(errors: Errors<K>): Errors<K> {
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as Errors<K>;
}
