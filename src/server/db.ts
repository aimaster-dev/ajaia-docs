import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { attachmentTypeOf } from '../shared/attachments.js';
import type { Attachment, DocumentDetail, DocumentSummary, Role, Share, ShareRole, User } from '../shared/types.js';

/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version`.
 * Append new entries; never edit an existing one once it has shipped.
 */
export const MIGRATIONS: string[] = [
  // 1: demo version (mocked sign-in by email).
  `
  CREATE TABLE users (
    id    TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    title        TEXT NOT NULL,
    content_html TEXT NOT NULL DEFAULT '',
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT REFERENCES users(id)
  );
  CREATE INDEX idx_documents_owner ON documents(owner_id, updated_at DESC);

  CREATE TABLE document_shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );
  CREATE INDEX idx_shares_user ON document_shares(user_id);
  `,

  // 2: real accounts. Users sign in with a username and password; email is gone.
  // SQLite can't drop a NOT NULL UNIQUE column in place, so the users table is
  // rebuilt (the documented 12-step procedure; foreign keys are off while it runs).
  // Existing users keep their id, documents and shares; their username comes
  // from the part of the old email before "@", and they have no password until
  // one is set. Old sessions are dropped so everyone signs in again.
  `
  CREATE TABLE users_new (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL,
    password_hash TEXT,
    created_at    TEXT NOT NULL
  );
  INSERT INTO users_new (id, username, name, color, password_hash, created_at)
    SELECT id,
           lower(CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE email END),
           name, color, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;

  DELETE FROM sessions;
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  `,

  // 3: file attachments. Metadata and bytes live in separate tables so listing
  // attachments never reads file contents. Deleting a document (or an
  // attachment) cascades to the bytes, so no orphaned files can be left behind.
  `
  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL CHECK (size >= 0),
    sha256      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_attachments_document ON attachments(document_id, created_at);

  CREATE TABLE attachment_blobs (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    data          BLOB NOT NULL
  );
  `,
];

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

function detailFrom(row: Row): DocumentDetail {
  return {
    ...summaryFrom(row),
    contentHtml: String(row.content_html),
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

export type UpdateResult =
  | { ok: true; doc: DocumentDetail }
  | { ok: false; reason: 'conflict'; current: DocumentDetail };

/** Thrown by createUser when the username is already taken (including races). */
export class UsernameTakenError extends Error {}

/**
 * All persistence lives behind this class so route handlers never touch SQL.
 * Uses Node's built-in SQLite driver (no native build step). Every method is
 * synchronous, which keeps each request's reads and writes atomic in practice.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  close() {
    this.db.close();
  }

  /**
   * Foreign keys stay off while migrating (SQLite ignores the pragma inside a
   * transaction, and table rebuilds need it off). Each migration then runs
   * `foreign_key_check` before committing, so a broken reference rolls it back.
   */
  private migrate() {
    this.db.exec('PRAGMA foreign_keys = OFF;');
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        const broken = this.db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign key(s).`);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private txDepth = 0;

  /**
   * Runs `fn` atomically. Nested calls (e.g. saving an attachment while
   * importing a document) become savepoints, so an inner failure can be
   * handled without abandoning the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    const savepoint = this.txDepth > 0 ? `sp_${this.txDepth}` : null;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ---- users -------------------------------------------------------------

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as Row | undefined;
    return row ? userFrom(row) : null;
  }

  /** `username` must already be normalized (see normalizeUsername). */
  getUserByUsername(username: string): User | null {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) as
      | Row
      | undefined;
    return row ? userFrom(row) : null;
  }

  /** Everything needed to check a sign-in. Never send `passwordHash` to the client. */
  getCredentials(username: string): { user: User; passwordHash: string | null } | null {
    const row = this.db
      .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`)
      .get(username) as Row | undefined;
    if (!row) return null;
    return { user: userFrom(row)!, passwordHash: (row.password_hash as string | null) ?? null };
  }

  getPasswordHash(userId: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined;
    return (row?.password_hash as string | null | undefined) ?? null;
  }

  createUser(input: Omit<User, 'id'> & { id?: string; passwordHash: string }): User {
    const id = input.id ?? randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, username, name, color, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.username, input.name, input.color, input.passwordHash, new Date().toISOString());
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE constraint failed: users.username')) {
        throw new UsernameTakenError(input.username);
      }
      throw err;
    }
    return this.getUserById(id)!;
  }

  setPasswordHash(userId: string, passwordHash: string) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }

  /**
   * People to suggest in the share dialog: usernames starting with `query`,
   * or names containing a word starting with it. Excludes the person searching.
   */
  searchUsers(query: string, excludeUserId: string, limit = 8): User[] {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (!q) return [];
    const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE id != :exclude
           AND (username LIKE :prefix ESCAPE '\\' OR lower(name) LIKE :prefix ESCAPE '\\' OR lower(name) LIKE :word ESCAPE '\\')
         ORDER BY (username LIKE :prefix ESCAPE '\\') DESC, username
         LIMIT :limit`,
      )
      .all({ exclude: excludeUserId, prefix: `${like}%`, word: `% ${like}%`, limit })
      .map((r) => userFrom(r as Row)!);
  }

  // ---- sessions ----------------------------------------------------------

  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, now.toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  getSessionUser(token: string): User | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.name, u.color FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, new Date().toISOString()) as Row | undefined;
    return row ? userFrom(row) : null;
  }

  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** Signs the user out everywhere, optionally keeping one session (the current one). */
  deleteSessionsForUser(userId: string, exceptToken?: string) {
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
      .run(userId, exceptToken ?? '');
  }

  /** Housekeeping: drop expired sessions. */
  purgeExpiredSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }

  // ---- documents ---------------------------------------------------------

  /** Every document the user can open, newest first, with their role on each. */
  listDocuments(userId: string): DocumentSummary[] {
    return this.db
      .prepare(
        `${DOC_SELECT}
         WHERE d.owner_id = :uid OR s.user_id IS NOT NULL
         ORDER BY d.updated_at DESC`,
      )
      .all({ uid: userId })
      .map((r) => summaryFrom(r as Row));
  }

  /** Returns the document only if the user owns it or it has been shared with them. */
  getDocument(docId: string, userId: string): DocumentDetail | null {
    const row = this.db
      .prepare(`${DOC_SELECT} WHERE d.id = :id AND (d.owner_id = :uid OR s.user_id IS NOT NULL)`)
      .get({ id: docId, uid: userId }) as Row | undefined;
    return row ? detailFrom(row) : null;
  }

  createDocument(ownerId: string, title: string, contentHtml: string): DocumentDetail {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (id, owner_id, title, content_html, version, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, ownerId, title, contentHtml, now, now, ownerId);
    return this.getDocument(id, ownerId)!;
  }

  /** Sets content without a version bump. Only for filling in a brand-new document (e.g. after import). */
  replaceContent(docId: string, contentHtml: string) {
    this.db.prepare('UPDATE documents SET content_html = ? WHERE id = ?').run(contentHtml, docId);
  }

  renameDocument(docId: string, userId: string, title: string): DocumentDetail {
    this.db
      .prepare('UPDATE documents SET title = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(title, new Date().toISOString(), userId, docId);
    return this.getDocument(docId, userId)!;
  }

  /**
   * Optimistic concurrency: the write only lands if `baseVersion` is still the
   * latest version, so two people saving at once can't silently overwrite each other.
   */
  updateContent(docId: string, userId: string, contentHtml: string, baseVersion: number): UpdateResult {
    const result = this.db
      .prepare(
        `UPDATE documents
         SET content_html = ?, version = version + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND version = ?`,
      )
      .run(contentHtml, new Date().toISOString(), userId, docId, baseVersion);
    const doc = this.getDocument(docId, userId)!;
    return Number(result.changes) === 1 ? { ok: true, doc } : { ok: false, reason: 'conflict', current: doc };
  }

  deleteDocument(docId: string) {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  }

  // ---- sharing -----------------------------------------------------------

  listShares(docId: string): Share[] {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.name, u.color, s.role, s.created_at
         FROM document_shares s JOIN users u ON u.id = s.user_id
         WHERE s.document_id = ? ORDER BY s.created_at`,
      )
      .all(docId)
      .map((r) => {
        const row = r as Row;
        return { user: userFrom(row)!, role: row.role as ShareRole, createdAt: String(row.created_at) };
      });
  }

  upsertShare(docId: string, userId: string, role: ShareRole) {
    this.db
      .prepare(
        `INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(docId, userId, role, new Date().toISOString());
  }

  removeShare(docId: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?')
      .run(docId, userId);
    return Number(result.changes) > 0;
  }

  // ---- attachments -------------------------------------------------------

  listAttachments(docId: string): Attachment[] {
    return this.db
      .prepare(`${ATTACHMENT_SELECT} WHERE a.document_id = ? ORDER BY a.created_at, a.rowid`)
      .all(docId)
      .map((r) => attachmentFrom(r as Row));
  }

  countAttachments(docId: string): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE document_id = ?').get(docId) as Row).n,
    );
  }

  /** Metadata for one attachment, only if it belongs to `docId` (so ids can't be used across documents). */
  getAttachment(docId: string, attachmentId: string): (Attachment & { sha256: string }) | null {
    const row = this.db
      .prepare(`${ATTACHMENT_SELECT} WHERE a.document_id = ? AND a.id = ?`)
      .get(docId, attachmentId) as Row | undefined;
    return row ? { ...attachmentFrom(row), sha256: String(row.sha256) } : null;
  }

  getAttachmentData(attachmentId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT data FROM attachment_blobs WHERE attachment_id = ?').get(attachmentId) as
      | Row
      | undefined;
    return row ? (row.data as Uint8Array) : null;
  }

  createAttachment(input: {
    documentId: string;
    uploadedBy: string;
    filename: string;
    mimeType: string;
    sha256: string;
    data: Uint8Array;
  }): Attachment {
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO attachments (id, document_id, uploaded_by, filename, mime_type, size, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.documentId,
          input.uploadedBy,
          input.filename,
          input.mimeType,
          input.data.byteLength,
          input.sha256,
          new Date().toISOString(),
        );
      this.db.prepare('INSERT INTO attachment_blobs (attachment_id, data) VALUES (?, ?)').run(id, input.data);
    });
    // The hash is internal (used for ETags); keep it out of API responses.
    const { sha256: _hash, ...attachment } = this.getAttachment(input.documentId, id)!;
    return attachment;
  }

  deleteAttachment(docId: string, attachmentId: string): boolean {
    const result = this.db.prepare('DELETE FROM attachments WHERE document_id = ? AND id = ?').run(docId, attachmentId);
    return Number(result.changes) > 0;
  }
}
