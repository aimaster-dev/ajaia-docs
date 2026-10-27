// Production entry point: serves the API and the built React app from one process.
import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from './app.js';
import { config, describeDatabase } from './config.js';
import { Store } from './db.js';
import { seedDemoAccounts } from './seed.js';

const clientDir = resolve(import.meta.dirname, '../client');
if (!existsSync(join(clientDir, 'index.html'))) {
  console.error(`Built client not found in ${clientDir}. Run "npm run build" first.`);
  process.exit(1);
}

const database = config.database;
const store = await Store.open(database);
if (config.demoAccounts) await seedDemoAccounts(store);

const app = createApp(store, {
  strictCsp: true,
  demoAccounts: config.demoAccounts,
  frontend: (app) => {
    app.use('/assets', express.static(join(clientDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(clientDir, { index: false }));
    // Client-side routes (e.g. /docs/:id) all load the same page.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(join(clientDir, 'index.html'));
    });
  },
});

const server = app.listen(config.port, () => {
  console.log(`Ajaia Docs listening on http://localhost:${config.port} (db: ${describeDatabase(database)})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
