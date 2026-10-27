import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { UsernameTakenError, type Store } from './db.js';
import { HttpError, forbidden } from './errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { RateLimiter } from './rateLimit.js';
import { parseBody } from './validate.js';
import {
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_HINT,
  USERNAME_PATTERN,
  normalizeUsername,
  type AuthConfig,
  type User,
} from '../shared/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE = 'ajaia_sid';

const MINUTE = 60_000;
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#c2410c', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#4f46e5'];

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Resolves the session cookie (if any) to a user. Never rejects the request on its own. */
export function attachUser(store: Store) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = await store.getSessionUser(token);
      if (user) {
        req.user = user;
        req.sessionToken = token;
      }
    }
    next();
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new HttpError(401, 'unauthenticated', 'Please sign in first.'));
    return;
  }
  next();
}

// ---- validation -------------------------------------------------------------

const NewUsername = z
  .string({ error: 'Choose a username.' })
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(MIN_USERNAME_LENGTH, `Username must be at least ${MIN_USERNAME_LENGTH} characters.`)
      .max(MAX_USERNAME_LENGTH, `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`)
      .regex(USERNAME_PATTERN, `${USERNAME_HINT} It must start and end with a letter or number.`),
  );

const NewPassword = z
  .string({ error: 'Choose a password.' })
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`)
  .refine((p) => p.trim().length > 0, 'Password can’t be only spaces.');

const Name = z
  .string({ error: 'Enter your name.' })
  .trim()
  .min(1, 'Enter your name.')
  .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer.`);

const RegisterBody = z
  .object({ name: Name, username: NewUsername, password: NewPassword })
  .refine((b) => b.password.toLowerCase() !== b.username, {
    message: 'Password can’t be the same as your username.',
    path: ['password'],
  });

const LoginBody = z.object({
  username: z.string({ error: 'Enter your username.' }).transform(normalizeUsername).pipe(z.string().min(1, 'Enter your username.')),
  // Capped so nobody can make us hash megabytes of input.
  password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(1024, 'Password is too long.'),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string({ error: 'Enter your current password.' }).min(1, 'Enter your current password.').max(1024),
  newPassword: NewPassword,
});

// ---- routes -------------------------------------------------------------------

export interface AuthOptions {
  demo: AuthConfig['demo'];
  /** Shared demo accounts can't change their password (it would lock other reviewers out). */
  demoUserIds: ReadonlySet<string>;
}

/**
 * Username + password accounts with server-side sessions.
 * - Passwords: scrypt with a per-user salt (see password.ts); never logged or returned.
 * - Sessions: random 256-bit token in an httpOnly, SameSite=Lax cookie; Secure behind HTTPS.
 * - Guessing: failed sign-ins are rate limited per username+IP and per IP; unknown
 *   usernames get the same message and timing as wrong passwords.
 */
export function authRouter(store: Store, options: AuthOptions) {
  const router = Router();
  const limiter = new RateLimiter();

  const startSession = async (req: Request, res: Response, userId: string) => {
    const { token, expiresAt } = await store.createSession(userId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      expires: expiresAt,
      path: '/',
    });
  };

  router.get('/config', (_req, res) => {
    const body: AuthConfig = { demo: options.demo };
    res.json(body);
  });

  router.post('/register', async (req, res) => {
    limiter.hit(`register:${req.ip}`, 10, 60 * MINUTE);
    const body = parseBody(RegisterBody, req.body);
    if (await store.getUserByUsername(body.username)) {
      throw new HttpError(409, 'username_taken', 'That username is taken. Try another one.', { field: 'username' });
    }

    const passwordHash = await hashPassword(body.password);
    let user: User;
    try {
      const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
      user = await store.createUser({ username: body.username, name: body.name, color, passwordHash });
    } catch (err) {
      // Someone registered the same name while we were hashing.
      if (err instanceof UsernameTakenError) {
        throw new HttpError(409, 'username_taken', 'That username is taken. Try another one.', { field: 'username' });
      }
      throw err;
    }
    await store.purgeExpiredSessions();
    await startSession(req, res, user.id);
    res.status(201).json({ user });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = parseBody(LoginBody, req.body);
    const accountKey = `login:${req.ip}:${username}`;
    limiter.hit(`login-ip:${req.ip}`, 100, 15 * MINUTE); // spraying many usernames
    limiter.hit(accountKey, 5, 15 * MINUTE); // guessing one account's password

    const creds = await store.getCredentials(username);
    const ok = creds?.passwordHash
      ? await verifyPassword(password, creds.passwordHash)
      : await verifyAgainstDummy(password);
    if (!ok || !creds) {
      throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
    }

    limiter.reset(accountKey);
    await store.purgeExpiredSessions();
    await startSession(req, res, creds.user.id);
    res.json({ user: creds.user });
  });

  router.post('/logout', async (req, res) => {
    if (req.sessionToken) await store.deleteSession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ?? null });
  });

  router.post('/password', requireUser, async (req, res) => {
    const user = req.user!;
    if (options.demoUserIds.has(user.id)) {
      throw forbidden('Demo accounts share one password, so it can’t be changed. Create your own account to try this.');
    }
    const { currentPassword, newPassword } = parseBody(ChangePasswordBody, req.body);
    limiter.hit(`password:${user.id}`, 5, 15 * MINUTE);

    const hash = await store.getPasswordHash(user.id);
    if (!hash || !(await verifyPassword(currentPassword, hash))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is incorrect.', { field: 'currentPassword' });
    }
    if (newPassword.toLowerCase() === user.username) {
      throw new HttpError(400, 'validation_error', 'Password can’t be the same as your username.', { field: 'newPassword' });
    }

    await store.setPasswordHash(user.id, await hashPassword(newPassword));
    // Anyone holding an old session (e.g. a stolen cookie) is signed out; this device stays in.
    await store.deleteSessionsForUser(user.id, req.sessionToken);
    limiter.reset(`password:${user.id}`);
    res.status(204).end();
  });

  return router;
}
