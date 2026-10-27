import { resolve } from 'node:path';
import { localDatabase, type DatabaseConfig } from './db.js';

/**
 * The database: Turso when TURSO_DATABASE_URL is set (production on Vercel),
 * otherwise a SQLite file on this machine (DATABASE_PATH, default data/ajaia-docs.db).
 */
function databaseConfig(): DatabaseConfig {
  const url = process.env.TURSO_DATABASE_URL ?? process.env.LIBSQL_URL;
  if (url) return { url, authToken: process.env.TURSO_AUTH_TOKEN ?? process.env.LIBSQL_AUTH_TOKEN };
  return localDatabase(resolve(process.env.DATABASE_PATH ?? 'data/ajaia-docs.db'));
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  get database() {
    return databaseConfig();
  },
  /** Shared demo accounts (alice, bob, carol). Set DEMO_ACCOUNTS=false to turn them off. */
  demoAccounts: process.env.DEMO_ACCOUNTS !== 'false',
};

/** Where the data lives, for log lines (never includes the auth token). */
export function describeDatabase(db: DatabaseConfig): string {
  return db.url.startsWith('file:') || db.url === ':memory:' ? db.url : new URL(db.url).host;
}
