import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client, InArgs, InStatement } from '@libsql/client';
import { attachmentTypeOf } from '../shared/attachments.js';
import type { Attachment, DocumentDetail, DocumentSummary, Role, Share, ShareRole, User } from '../shared/types.js';

/**
 * Where the data lives. `url` is either local, `file:<path>` or `:memory:`
 * (development and tests), or remote, `libsql://…` or `https://…` (Turso, in
 * production on Vercel). Both speak the same SQLite dialect, so every query
 * below runs unchanged on either.
 */
export interface DatabaseConfig {
  url: string;
  authToken?: string;
}

/** A database file on this machine (created, with its folder, if missing). */
export function localDatabase(path: string): DatabaseConfig {
  if (path === ':memory:') return { url: path };
  mkdirSync(dirname(path), { recursive: true });
  return { url: `file:${path.replace(/\\/g, '/')}` };
}

// ---- schema ----------------------------------------------------------------------

/**
 * Upgrade steps for existing databases, applied in order. Append new steps;
 * never edit one that has shipped. Each step is a list of statements.
 */
export const MIGRATIONS: string[][] = [
  // 1: demo version (mocked sign-in by email).
  [
    `CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name  TEXT NOT NULL,
      color TEXT NOT NULL
    )`,
    `CREATE TABLE sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE documents (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL REFERENCES users(id),
      title        TEXT NOT NULL,
      content_html TEXT NOT NULL DEFAULT '',
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      updated_by   TEXT REFERENCES users(id)
    )`,
    'CREATE INDEX idx_documents_owner ON documents(owner_id, updated_at DESC)',
    `CREATE TABLE document_shares (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
      created_at  TEXT NOT NULL,
      PRIMARY KEY (document_id, user_id)
    )`,
    'CREATE INDEX idx_shares_user ON document_shares(user_id)',
  ],

  // 2: real accounts. Users sign in with a username and password; email is gone.
  // SQLite can't drop a NOT NULL UNIQUE column in place, so the users table is
  // rebuilt (the documented 12-step procedure; foreign keys are off while it runs).
  // Existing users keep their id, documents and shares; their username comes
  // from the part of the old email before "@", and they have no password until
  // one is set. Old sessions are dropped so everyone signs in again.
  [
    `CREATE TABLE users_new (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      color         TEXT NOT NULL,
      password_hash TEXT,
      created_at    TEXT NOT NULL
    )`,
    `INSERT INTO users_new (id, username, name, color, password_hash, created_at)
      SELECT id,
             lower(CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE email END),
             name, color, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM users`,
    'DROP TABLE users',
    'ALTER TABLE users_new RENAME TO users',
    'DELETE FROM sessions',
    'CREATE INDEX idx_sessions_user ON sessions(user_id)',
  ],

  // 3: file attachments. Metadata and bytes live in separate tables so listing
  // attachments never reads file contents.
  [
    `CREATE TABLE attachments (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size        INTEGER NOT NULL CHECK (size >= 0),
      sha256      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    'CREATE INDEX idx_attachments_document ON attachments(document_id, created_at)',
    `CREATE TABLE attachment_blobs (
      attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
      data          BLOB NOT NULL
    )`,
  ],
];

/**
 * Today's schema, for a brand-new database: the result of all MIGRATIONS in one
 * step. `IF NOT EXISTS` makes it safe if two servers start against an empty
 * database at once (two serverless instances cold-starting together).
 * tests/migration.test.ts checks this matches the migrated schema.
 */
export const BASELINE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL,
    password_hash TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  `CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    title        TEXT NOT NULL,
    content_html TEXT NOT NULL DEFAULT '',
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT REFERENCES users(id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS document_shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id)',
  `CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL CHECK (size >= 0),
    sha256      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_attachments_document ON attachments(document_id, created_at)',
  `CREATE TABLE IF NOT EXISTS attachment_blobs (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    data          BLOB NOT NULL
  )`,
];

/** The schema version lives in a table (Turso doesn't keep SQLite's header field). */
const setVersion = (version: number): InStatement[] => [
  'CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
  {
    sql: 'INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version',
    args: [version],
  },
];

// ---- row mapping -------------------------------------------------------------------

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

const USER_COLUMNS = 'id, username, name, color';

const DOC_SELECT = `
  SELECT d.id, d.title, d.content_html, d.version, d.created_at, d.updated_at,
         CASE WHEN d.owner_id = :uid THEN 'owner' ELSE s.role END AS role,
         o.id AS o_id, o.username AS o_username, o.name AS o_name, o.color AS o_color,
         ub.id AS ub_id, ub.username AS ub_username, ub.name AS ub_name, ub.color AS ub_color,
         (SELECT COUNT(*) FROM document_shares x WHERE x.document_id = d.id) AS share_count,
         (SELECT COUNT(*) FROM attachments a WHERE a.document_id = d.id) AS attachment_count
  FROM documents d
  JOIN users o ON o.id = d.owner_id
  LEFT JOIN users ub ON ub.id = d.updated_by
  LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = :uid
`;

function userFrom(row: Row, prefix = ''): User | null {
  if (row[`${prefix}id`] == null) return null;
  return {
    id: String(row[`${prefix}id`]),
    username: String(row[`${prefix}username`]),
    name: String(row[`${prefix}name`]),
    color: String(row[`${prefix}color`]),
  };
}

function summaryFrom(row: Row): DocumentSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    role: row.role as Role,
    owner: userFrom(row, 'o_')!,
    updatedAt: String(row.updated_at),
    updatedBy: userFrom(row, 'ub_'),
    sharedWithCount: Number(row.share_count),
    attachmentCount: Number(row.attachment_count),
  };
}

function detailFrom(row: Row): DocumentDetail {
  return {
    ...summaryFrom(row),
    contentHtml: String(row.content_html),
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

function attachmentFrom(row: Row): Attachment {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    kind: attachmentTypeOf(String(row.filename))?.kind ?? 'text',
    size: Number(row.size),
    uploadedBy: userFrom(row, 'u_'),
    createdAt: String(row.created_at),
  };
}

const ATTACHMENT_SELECT = `
  SELECT a.id, a.document_id, a.filename, a.mime_type, a.size, a.sha256, a.created_at,
         u.id AS u_id, u.username AS u_username, u.name AS u_name, u.color AS u_color
  FROM attachments a
  LEFT JOIN users u ON u.id = a.uploaded_by
`;

export type UpdateResult =
  | { ok: true; doc: DocumentDetail }
  | { ok: false; reason: 'conflict'; current: DocumentDetail };

/** Thrown by createUser when the username is already taken (including races). */
export class UsernameTakenError extends Error {}

export interface NewAttachment {
  id?: string;
  documentId: string;
  uploadedBy: string;
  filename: string;
  mimeType: string;
  sha256: string;
  data: Uint8Array;
}

async function connect({ url, authToken }: DatabaseConfig): Promise<Client> {
  if (url === ':memory:' || url.startsWith('file:')) {
    const { createClient } = await import('@libsql/client');
    // One connection: requests take turns, as with a single SQLite handle, so
    // concurrent writes never fail with "database is locked".
    return createClient({ url, concurrency: 1 });
  }
  // Remote (Turso): HTTP is stateless, which suits serverless functions, and
  // needs no native driver.
  const { createClient } = await import('@libsql/client/web');
  return createClient({ url: url.replace(/^libsql:\/\//, 'https://'), authToken });
}

/**
 * All persistence lives behind this class so route handlers never touch SQL.
 *
 * Every write that touches more than one row is sent as one atomic batch:
 * it all lands or none of it does, in a single round trip to Turso, and
 * without holding a transaction open across awaits. Related rows are deleted
 * explicitly rather than relying on ON DELETE CASCADE, so correctness doesn't
 * depend on whether a given connection enforces foreign keys.
 */
export class Store {
  private constructor(readonly client: Client) {}

  static async open(config: DatabaseConfig): Promise<Store> {
    const client = await connect(config);
    if (config.url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL');
    const store = new Store(client);
    await store.migrate();
    return store;
  }

  close() {
    this.client.close();
  }

  // ---- query helpers --------------------------------------------------------

  private async rows(sql: string, args: InArgs = []): Promise<Row[]> {
    const result = await this.client.execute({ sql, args });
    return result.rows as unknown as Row[];
  }

  private async row(sql: string, args: InArgs = []): Promise<Row | undefined> {
    return (await this.rows(sql, args))[0];
  }

  private async run(sql: string, args: InArgs = []): Promise<number> {
    return (await this.client.execute({ sql, args })).rowsAffected;
  }

  /** Writes that succeed or fail together. */
  private async atomically(statements: InStatement[]) {
    return this.client.batch(statements, 'write');
  }

  // ---- schema ---------------------------------------------------------------

  async schemaVersion(): Promise<number> {
    const tables = new Set(
      (await this.rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name)),
    );
    if (tables.has('schema_meta')) {
      return Number((await this.row('SELECT version FROM schema_meta WHERE id = 1'))?.version ?? 0);
    }
    if (!tables.has('users')) return 0; // brand-new database
    // Local files from before schema_meta existed kept the version in SQLite's header.
    return Number((await this.row('PRAGMA user_version'))?.user_version ?? 0);
  }

  private async migrate() {
    const version = await this.schemaVersion();
    if (version >= MIGRATIONS.length) return;

    if (version === 0) {
      await this.atomically([...BASELINE_SCHEMA, ...setVersion(MIGRATIONS.length)]);
      return;
    }

    // An existing database replays only the steps it's missing. `migrate()`
    // turns foreign keys off around each step (the users-table rebuild needs it).
    for (let v = version; v < MIGRATIONS.length; v++) {
      await this.client.migrate([...MIGRATIONS[v]!, ...setVersion(v + 1)]);
      const broken = await this.rows('PRAGMA foreign_key_check');
      if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign key(s).`);
    }
  }

  // ---- users ----------------------------------------------------------------

  async countUsers(): Promise<number> {
    return Number((await this.row('SELECT COUNT(*) AS n FROM users'))?.n ?? 0);
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.row(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
    return row ? userFrom(row) : null;
  }

  /** `username` must already be normalized (see normalizeUsername). */
  async getUserByUsername(username: string): Promise<User | null> {
    const row = await this.row(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`, [username]);
    return row ? userFrom(row) : null;
  }

  /** Everything needed to check a sign-in. Never send `passwordHash` to the client. */
  async getCredentials(username: string): Promise<{ user: User; passwordHash: string | null } | null> {
    const row = await this.row(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`, [username]);
    if (!row) return null;
    return { user: userFrom(row)!, passwordHash: (row.password_hash as string | null) ?? null };
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const row = await this.row('SELECT password_hash FROM users WHERE id = ?', [userId]);
    return (row?.password_hash as string | null | undefined) ?? null;
  }

  async createUser(input: Omit<User, 'id'> & { id?: string; passwordHash: string }): Promise<User> {
    const id = input.id ?? randomUUID();
    try {
      await this.run(
        'INSERT INTO users (id, username, name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, input.username, input.name, input.color, input.passwordHash, new Date().toISOString()],
      );
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE constraint failed: users.username')) {
        throw new UsernameTakenError(input.username);
      }
      throw err;
    }
    return (await this.getUserById(id))!;
  }

  async setPasswordHash(userId: string, passwordHash: string) {
    await this.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  }

  /**
   * People to suggest in the share dialog: usernames starting with `query`,
   * or names containing a word starting with it. Excludes the person searching.
   */
  async searchUsers(query: string, excludeUserId: string, limit = 8): Promise<User[]> {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (!q) return [];
    const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.rows(
      `SELECT ${USER_COLUMNS} FROM users
       WHERE id != :exclude
         AND (username LIKE :prefix ESCAPE '\\' OR lower(name) LIKE :prefix ESCAPE '\\' OR lower(name) LIKE :word ESCAPE '\\')
       ORDER BY (username LIKE :prefix ESCAPE '\\') DESC, username
       LIMIT :limit`,
      { exclude: excludeUserId, prefix: `${like}%`, word: `% ${like}%`, limit },
    );
    return rows.map((r) => userFrom(r)!);
  }

  /**
   * Creates the shared demo accounts and sample documents if they're missing,
   * in one atomic batch. Every insert is "ON CONFLICT DO NOTHING", so running it
   * again (or from two servers at once) changes nothing; existing accounts only
   * get a password if they have none.
   */
  async ensureDemoData(input: {
    users: (User & { passwordHash: string })[];
    documents: { id: string; ownerId: string; title: string; contentHtml: string }[];
    shares: { documentId: string; userId: string; role: ShareRole }[];
  }) {
    const now = new Date().toISOString();
    await this.atomically([
      ...input.users.flatMap((u): InStatement[] => [
        {
          sql: `INSERT INTO users (id, username, name, color, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [u.id, u.username, u.name, u.color, u.passwordHash, now],
        },
        { sql: 'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL', args: [u.passwordHash, u.id] },
      ]),
      ...input.documents.map(
        (d): InStatement => ({
          sql: `INSERT INTO documents (id, owner_id, title, content_html, version, created_at, updated_at, updated_by)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [d.id, d.ownerId, d.title, d.contentHtml, now, now, d.ownerId],
        }),
      ),
      ...input.shares.map(
        (s): InStatement => ({
          sql: 'INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          args: [s.documentId, s.userId, s.role, now],
        }),
      ),
    ]);
  }

  // ---- sessions -------------------------------------------------------------

  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      token,
      userId,
      now.toISOString(),
      expiresAt.toISOString(),
    ]);
    return { token, expiresAt };
  }

  async getSessionUser(token: string): Promise<User | null> {
    const row = await this.row(
      `SELECT u.id, u.username, u.name, u.color FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
      [token, new Date().toISOString()],
    );
    return row ? userFrom(row) : null;
  }

  async deleteSession(token: string) {
    await this.run('DELETE FROM sessions WHERE token = ?', [token]);
  }

  /** Signs the user out everywhere, optionally keeping one session (the current one). */
  async deleteSessionsForUser(userId: string, exceptToken?: string) {
    await this.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, exceptToken ?? '']);
  }

  /** Housekeeping: drop expired sessions. */
  async purgeExpiredSessions() {
    await this.run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  }

  // ---- documents ------------------------------------------------------------

  /** Every document the user can open, newest first, with their role on each. */
  async listDocuments(userId: string): Promise<DocumentSummary[]> {
    const rows = await this.rows(
      `${DOC_SELECT}
       WHERE d.owner_id = :uid OR s.user_id IS NOT NULL
       ORDER BY d.updated_at DESC`,
      { uid: userId },
    );
    return rows.map(summaryFrom);
  }

  /** Returns the document only if the user owns it or it has been shared with them. */
  async getDocument(docId: string, userId: string): Promise<DocumentDetail | null> {
    const row = await this.row(`${DOC_SELECT} WHERE d.id = :id AND (d.owner_id = :uid OR s.user_id IS NOT NULL)`, {
      id: docId,
      uid: userId,
    });
    return row ? detailFrom(row) : null;
  }

  private insertDocument(id: string, ownerId: string, title: string, contentHtml: string): InStatement {
    const now = new Date().toISOString();
    return {
      sql: `INSERT INTO documents (id, owner_id, title, content_html, version, created_at, updated_at, updated_by)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      args: [id, ownerId, title, contentHtml, now, now, ownerId],
    };
  }

  async createDocument(ownerId: string, title: string, contentHtml: string): Promise<DocumentDetail> {
    const id = randomUUID();
    await this.client.execute(this.insertDocument(id, ownerId, title, contentHtml));
    return (await this.getDocument(id, ownerId))!;
  }

  /**
   * Creates a document together with its attachments (e.g. pictures from an
   * imported .docx) in one atomic batch. The caller picks the ids up front so
   * the content can already point at the attachments.
   */
  async createDocumentWithAttachments(input: {
    id: string;
    ownerId: string;
    title: string;
    contentHtml: string;
    attachments: NewAttachment[];
  }): Promise<DocumentDetail> {
    await this.atomically([
      this.insertDocument(input.id, input.ownerId, input.title, input.contentHtml),
      ...input.attachments.flatMap((a) => this.insertAttachment({ ...a, id: a.id ?? randomUUID() })),
    ]);
    return (await this.getDocument(input.id, input.ownerId))!;
  }

  async renameDocument(docId: string, userId: string, title: string): Promise<DocumentDetail> {
    await this.run('UPDATE documents SET title = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      title,
      new Date().toISOString(),
      userId,
      docId,
    ]);
    return (await this.getDocument(docId, userId))!;
  }

  /**
   * Optimistic concurrency: the write only lands if `baseVersion` is still the
   * latest version, so two people saving at once can't silently overwrite each other.
   * A new `title` sent with the content is saved by the same statement, so a
   * rejected save never half-applies.
   */
  async updateContent(
    docId: string,
    userId: string,
    contentHtml: string,
    baseVersion: number,
    title?: string,
  ): Promise<UpdateResult> {
    const changed = await this.run(
      `UPDATE documents
       SET content_html = ?, title = coalesce(?, title), version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ?`,
      [contentHtml, title ?? null, new Date().toISOString(), userId, docId, baseVersion],
    );
    const doc = (await this.getDocument(docId, userId))!;
    return changed === 1 ? { ok: true, doc } : { ok: false, reason: 'conflict', current: doc };
  }

  /** Deletes the document and everything that belongs to it. */
  async deleteDocument(docId: string) {
    await this.atomically([
      {
        sql: 'DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM attachments WHERE document_id = ?)',
        args: [docId],
      },
      { sql: 'DELETE FROM attachments WHERE document_id = ?', args: [docId] },
      { sql: 'DELETE FROM document_shares WHERE document_id = ?', args: [docId] },
      { sql: 'DELETE FROM documents WHERE id = ?', args: [docId] },
    ]);
  }

  // ---- sharing --------------------------------------------------------------

  async listShares(docId: string): Promise<Share[]> {
    const rows = await this.rows(
      `SELECT u.id, u.username, u.name, u.color, s.role, s.created_at
       FROM document_shares s JOIN users u ON u.id = s.user_id
       WHERE s.document_id = ? ORDER BY s.created_at`,
      [docId],
    );
    return rows.map((row) => ({ user: userFrom(row)!, role: row.role as ShareRole, createdAt: String(row.created_at) }));
  }

  async upsertShare(docId: string, userId: string, role: ShareRole) {
    await this.run(
      `INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
      [docId, userId, role, new Date().toISOString()],
    );
  }

  async removeShare(docId: string, userId: string): Promise<boolean> {
    return (await this.run('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?', [docId, userId])) > 0;
  }

  // ---- attachments ----------------------------------------------------------

  async listAttachments(docId: string): Promise<Attachment[]> {
    const rows = await this.rows(`${ATTACHMENT_SELECT} WHERE a.document_id = ? ORDER BY a.created_at, a.rowid`, [docId]);
    return rows.map(attachmentFrom);
  }

  async countAttachments(docId: string): Promise<number> {
    return Number((await this.row('SELECT COUNT(*) AS n FROM attachments WHERE document_id = ?', [docId]))?.n ?? 0);
  }

  /** Metadata for one attachment, only if it belongs to `docId` (so ids can't be used across documents). */
  async getAttachment(docId: string, attachmentId: string): Promise<(Attachment & { sha256: string }) | null> {
    const row = await this.row(`${ATTACHMENT_SELECT} WHERE a.document_id = ? AND a.id = ?`, [docId, attachmentId]);
    return row ? { ...attachmentFrom(row), sha256: String(row.sha256) } : null;
  }

  async getAttachmentData(attachmentId: string): Promise<Uint8Array | null> {
    const row = await this.row('SELECT data FROM attachment_blobs WHERE attachment_id = ?', [attachmentId]);
    const data = row?.data;
    if (data == null) return null;
    return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  }

  /**
   * Inserts one attachment and its bytes, but only while the document has fewer
   * than `limit` attachments. The count is checked inside the same write, so
   * two uploads at once can't both squeeze past the limit.
   */
  private insertAttachment(a: NewAttachment & { id: string }, limit = Number.MAX_SAFE_INTEGER): InStatement[] {
    return [
      {
        sql: `INSERT INTO attachments (id, document_id, uploaded_by, filename, mime_type, size, sha256, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?
              WHERE (SELECT COUNT(*) FROM attachments WHERE document_id = ?) < ?`,
        args: [
          a.id,
          a.documentId,
          a.uploadedBy,
          a.filename,
          a.mimeType,
          a.data.byteLength,
          a.sha256,
          new Date().toISOString(),
          a.documentId,
          limit,
        ],
      },
      {
        sql: 'INSERT INTO attachment_blobs (attachment_id, data) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ?)',
        args: [a.id, a.data, a.id],
      },
    ];
  }

  /** Saves a file to a document. Returns null if the document already has `limit` attachments. */
  async createAttachment(input: NewAttachment, limit?: number): Promise<Attachment | null> {
    const id = input.id ?? randomUUID();
    const [inserted] = await this.atomically(this.insertAttachment({ ...input, id }, limit));
    if (inserted!.rowsAffected === 0) return null;
    // The hash is internal (used for ETags); keep it out of API responses.
    const { sha256: _hash, ...attachment } = (await this.getAttachment(input.documentId, id))!;
    return attachment;
  }

  async deleteAttachment(docId: string, attachmentId: string): Promise<boolean> {
    const results = await this.atomically([
      {
        sql: 'DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM attachments WHERE document_id = ? AND id = ?)',
        args: [docId, attachmentId],
      },
      { sql: 'DELETE FROM attachments WHERE document_id = ? AND id = ?', args: [docId, attachmentId] },
    ]);
    return results[1]!.rowsAffected > 0;
  }
}
