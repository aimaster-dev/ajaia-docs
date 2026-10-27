// Development entry point: one process, one port. Vite runs as middleware
// (with hot reload) behind the same Express app the API uses.
import { createServer as createViteServer } from 'vite';
import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './db.js';
import { seedDemoAccounts } from './seed.js';

const store = new Store(config.databasePath);
if (config.demoAccounts) await seedDemoAccounts(store);

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
const app = createApp(store, {
  demoAccounts: config.demoAccounts,
  frontend: (app) => app.use(vite.middlewares),
});

app.listen(config.port, () => {
  console.log(`Ajaia Docs (dev) on http://localhost:${config.port} (db: ${config.databasePath})`);
});
