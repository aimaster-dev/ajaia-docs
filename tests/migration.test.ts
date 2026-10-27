import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, Store } from '../src/server/db.js';
import { verifyPassword } from '../src/server/password.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';

describe('database migration 1 → 2 (email sign-in → username + password)', () => {
  it('keeps every document, share and author while switching users to usernames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ajaia-migration-'));
    const path = join(dir, 'v1.db');

    // Build a database exactly as the previous release left it.
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.exec(`
      INSERT INTO users VALUES ('user_alice', 'alice@ajaia.test', 'Alice Chen', '#2563eb'),
                               ('u2', 'Zed.Smith@Example.com', 'Zed Smith', '#000000');
      INSERT INTO sessions VALUES ('old-token', 'u2', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
      INSERT INTO documents VALUES ('d1', 'user_alice', 'Plan', '<p>x</p>', 3, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'u2');
      INSERT INTO document_shares VALUES ('d1', 'u2', 'editor', '2026-01-01T00:00:00Z');
    `);
    old.close();

    const store = new Store(path);
    try {
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(store.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Usernames come from the old email, lowercased; ids are unchanged.
      expect(store.getUserByUsername('zed.smith')).toMatchObject({ id: 'u2', name: 'Zed Smith' });
      expect(store.getUserByUsername('alice')).toMatchObject({ id: 'user_alice' });

      const doc = store.getDocument('d1', 'u2')!;
      expect(doc).toMatchObject({ title: 'Plan', role: 'editor', version: 3, contentHtml: '<p>x</p>' });
      expect(doc.owner.username).toBe('alice');
      expect(doc.updatedBy?.username).toBe('zed.smith');

      // Old sessions are dropped and carried-over users have no password yet.
      expect(store.getSessionUser('old-token')).toBeNull();
      expect(store.getPasswordHash('u2')).toBeNull();

      // Foreign keys still point at the rebuilt users table.
      expect(() => store.createDocument('ghost', 'Orphan', '')).toThrow(/FOREIGN KEY/);

      // Demo seeding gives the carried-over demo user its password, adds the
      // missing demo users, leaves everyone else alone, and adds no sample docs.
      await seedDemoAccounts(store);
      expect(await verifyPassword(DEMO_PASSWORD, store.getPasswordHash('user_alice')!)).toBe(true);
      expect(store.getUserByUsername('bob')).not.toBeNull();
      expect(store.getPasswordHash('u2')).toBeNull();
      expect(store.listDocuments('user_alice').map((d) => d.title)).toEqual(['Plan']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: reopening an upgraded database changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ajaia-migration-'));
    const path = join(dir, 'fresh.db');
    try {
      new Store(path).close();
      const again = new Store(path);
      expect(again.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
