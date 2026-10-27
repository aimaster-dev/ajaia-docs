// Vercel entry point. The API runs as one serverless function (api/index.js
// loads this module); Vercel serves the built React app itself from dist/client.
import type { Express } from 'express';
import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './db.js';
import { seedDemoAccounts } from './seed.js';

/** A setup problem worth showing in the browser, unlike unexpected errors. */
export class SetupError extends Error {
  readonly expose = true;
}

export async function createVercelApp(): Promise<Express> {
  // Serverless functions have no lasting disk, so the data must live in Turso.
  if (!process.env.TURSO_DATABASE_URL && !process.env.LIBSQL_URL) {
    throw new SetupError(
      'TURSO_DATABASE_URL is not set. Add your Turso database URL and token in Vercel ' +
        '(Settings → Environment Variables), then redeploy.',
    );
  }
  const store = await Store.open(config.database);
  if (config.demoAccounts) await seedDemoAccounts(store);
  return createApp(store, { strictCsp: true, demoAccounts: config.demoAccounts });
}
