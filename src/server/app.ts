import express, { type ErrorRequestHandler, type Express } from 'express';
import multer from 'multer';
import type { Store } from './db.js';
import { attachUser, authRouter, requireUser } from './auth.js';
import { documentsRouter } from './documents.js';
import { HttpError } from './errors.js';
import { DEMO_USER_IDS, demoConfig } from './seed.js';
import type { ApiErrorBody } from '../shared/types.js';

export interface AppOptions {
  /** Mounts the frontend (Vite dev middleware or built static files) after the API routes. */
  frontend?: (app: Express) => void;
  /** Adds a Content-Security-Policy. Off in dev because Vite injects inline scripts. */
  strictCsp?: boolean;
  /** Advertise the shared demo accounts on the sign-in page (and lock their passwords). */
  demoAccounts?: boolean;
}

export function createApp(store: Store, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind the hosting provider's proxy: trust X-Forwarded-Proto so secure cookies work.
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (options.strictCsp) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
      );
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser(store));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    '/api/auth',
    authRouter(store, {
      demo: demoConfig(options.demoAccounts ?? false),
      demoUserIds: options.demoAccounts ? DEMO_USER_IDS : new Set(),
    }),
  );
  // Share-dialog suggestions: ?q=<start of a username or name>
  app.get('/api/users', requireUser, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 64) : '';
    res.json({ users: store.searchUsers(q, req.user!.id) });
  });
  app.use('/api/documents', requireUser, documentsRouter(store));
  app.use('/api', () => {
    throw new HttpError(404, 'not_found', 'Unknown API route.');
  });

  options.frontend?.(app);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    let status = 500;
    let body: ApiErrorBody = { error: { code: 'internal_error', message: 'Something went wrong on our side.' } };

    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details as ApiErrorBody['error']['details'] } };
      const retryAfter = (err.details as { retryAfter?: number } | undefined)?.retryAfter;
      if (status === 429 && retryAfter) res.setHeader('Retry-After', String(retryAfter));
    } else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 5 MB limit.' : err.message;
      body = { error: { code: 'upload_error', message } };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { error: { code: 'payload_too_large', message: 'Request is too large.' } };
    } else {
      console.error(err);
    }
    res.status(status).json(body);
  };
  app.use(errorHandler);

  return app;
}
