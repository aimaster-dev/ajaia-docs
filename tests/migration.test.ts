import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, Store, localDatabase } from '../src/server/db.js';
import { verifyPassword } from '../src/server/password.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';

const dirs: string[] = [];
const tempPath = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'ajaia-migration-'));
  dirs.push(dir);
  return join(dir, name);
};
// libSQL releases a closed database file only once its statements are garbage
// collected, and Windows won't delete an open file. So collect, wait, then
// delete; anything still held is left to the OS temp folder.
setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;
afterAll(async () => {
  collectGarbage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // still locked (Windows only); harmless
    }
  }
});

/** Builds a database file the way an older release left it, at `version`. */
function legacyDatabase(path: string, version: number, seedSql = '') {
  const db = new DatabaseSync(path);
  for (const step of MIGRATIONS.slice(0, version)) db.exec(step.join(';\n'));
  db.exec(`PRAGMA user_version = ${version}`);
  if (seedSql) db.exec(seedSql);
  db.close();
}

/** Tables, columns, foreign keys and indexes, in a form that ignores how they were created. */
async function schemaShape(store: Store) {
  const q = async (sql: string) => (await store.client.execute(sql)).rows;
  const tables = await q(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_meta' ORDER BY name",
  );
  const shape: Record<string, unknown> = {};
  for (const { name } of tables) {
    const indexes = [];
    for (const ix of await q(`PRAGMA index_list(${name})`)) {
      const columns = (await q(`PRAGMA index_info(${ix.name})`)).map((c) => c.name);
      // Automatic (UNIQUE / PRIMARY KEY) index names depend on the table's original name.
      indexes.push([String(ix.name).startsWith('sqlite_autoindex') ? '(auto)' : ix.name, ix.unique, columns]);
    }
    shape[String(name)] = {
      columns: (await q(`PRAGMA table_info(${name})`)).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
      foreignKeys: (await q(`PRAGMA foreign_key_list(${name})`)).map((f) => [f.table, f.from, f.to, f.on_delete]),
      indexes: indexes.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    };
  }
  return shape;
}

describe('database migration 1 → 2 (email sign-in → username + password)', () => {
  it('keeps every document, share and author while switching users to usernames', async () => {
    const path = tempPath('v1.db');
    legacyDatabase(
      path,
      1,
      `
      INSERT INTO users VALUES ('user_alice', 'alice@ajaia.test', 'Alice Chen', '#2563eb'),
                               ('u2', 'Zed.Smith@Example.com', 'Zed Smith', '#000000');
      INSERT INTO sessions VALUES ('old-token', 'u2', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
      INSERT INTO documents VALUES ('d1', 'user_alice', 'Plan', '<p>x</p>', 3, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'u2');
      INSERT INTO document_shares VALUES ('d1', 'u2', 'editor', '2026-01-01T00:00:00Z');
    `,
    );

    const store = await Store.open(localDatabase(path));
    try {
      expect(await store.schemaVersion()).toBe(MIGRATIONS.length);
      expect((await store.client.execute('PRAGMA foreign_keys')).rows[0]!.foreign_keys).toBe(1);
      expect((await store.client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);

      // Usernames come from the old email, lowercased; ids are unchanged.
      expect(await store.getUserByUsername('zed.smith')).toMatchObject({ id: 'u2', name: 'Zed Smith' });
      expect(await store.getUserByUsername('alice')).toMatchObject({ id: 'user_alice' });

      const doc = (await store.getDocument('d1', 'u2'))!;
      expect(doc).toMatchObject({ title: 'Plan', role: 'editor', version: 3, contentHtml: '<p>x</p>' });
      expect(doc.owner.username).toBe('alice');
      expect(doc.updatedBy?.username).toBe('zed.smith');

      // Old sessions are dropped and carried-over users have no password yet.
      expect(await store.getSessionUser('old-token')).toBeNull();
      expect(await store.getPasswordHash('u2')).toBeNull();

      // Foreign keys still point at the rebuilt users table.
      await expect(store.createDocument('ghost', 'Orphan', '')).rejects.toThrow(/FOREIGN KEY/);

      // Demo seeding gives the carried-over demo user its password, adds the
      // missing demo users, leaves everyone else alone, and adds no sample docs.
      await seedDemoAccounts(store);
      expect(await verifyPassword(DEMO_PASSWORD, (await store.getPasswordHash('user_alice'))!)).toBe(true);
      expect(await store.getUserByUsername('bob')).not.toBeNull();
      expect(await store.getPasswordHash('u2')).toBeNull();
      expect((await store.listDocuments('user_alice')).map((d) => d.title)).toEqual(['Plan']);
    } finally {
      store.close();
    }
  });
});

describe('schema setup', () => {
  it('creates the same schema on a new database as upgrading an old one does', async () => {
    const path = tempPath('v1.db');
    legacyDatabase(path, 1);
    const upgraded = await Store.open(localDatabase(path));
    const fresh = await Store.open({ url: ':memory:' });
    try {
      expect(await schemaShape(fresh)).toEqual(await schemaShape(upgraded));
      expect(await fresh.schemaVersion()).toBe(MIGRATIONS.length);
    } finally {
      upgraded.close();
      fresh.close();
    }
  });

  it('is idempotent: reopening and reseeding changes nothing', async () => {
    const config = localDatabase(tempPath('fresh.db'));
    const first = await Store.open(config);
    await seedDemoAccounts(first);
    const before = await first.listDocuments('user_alice');
    first.close();

    const again = await Store.open(config);
    try {
      await seedDemoAccounts(again);
      expect(await again.schemaVersion()).toBe(MIGRATIONS.length);
      expect(await again.countUsers()).toBe(3);
      expect(await again.listDocuments('user_alice')).toEqual(before);
    } finally {
      again.close();
    }
  });

  it('opens a database from before the version table existed without redoing any step', async () => {
    const path = tempPath('v3.db');
    legacyDatabase(
      path,
      MIGRATIONS.length,
      `INSERT INTO users VALUES ('u1', 'dana', 'Dana', '#000000', NULL, '2026-01-01T00:00:00Z');
       INSERT INTO documents VALUES ('d1', 'u1', 'Kept', '<p>kept</p>', 7, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'u1');`,
    );
    const store = await Store.open(localDatabase(path));
    try {
      expect(await store.schemaVersion()).toBe(MIGRATIONS.length);
      expect(await store.getDocument('d1', 'u1')).toMatchObject({ title: 'Kept', version: 7 });
    } finally {
      store.close();
    }
  });
});
