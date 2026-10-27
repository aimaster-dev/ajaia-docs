import { resolve } from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: resolve(process.env.DATABASE_PATH ?? 'data/ajaia-docs.db'),
  /** Shared demo accounts (alice, bob, carol). Set DEMO_ACCOUNTS=false to turn them off. */
  demoAccounts: process.env.DEMO_ACCOUNTS !== 'false',
};
