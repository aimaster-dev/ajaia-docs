# Architecture note

**In one paragraph:** one Node 24 process (Express 5) serves a REST API and a React 19 + TipTap editor. Data lives in SQLite through Node's built-in `node:sqlite`, as one file on a Railway volume. Documents are stored as sanitized HTML, every save is version-checked so nobody is silently overwritten, and one server-side rule decides who can open a document and its files. It ships as a single Docker image.

## What I prioritized

1. **Never lose work.** Autosave is debounced, sends one request at a time, is version-checked and retries, and shows its status. Conflicts are surfaced, never silently resolved.
2. **Sharing is enforced on the server.** One access query decides owner, editor, viewer or no access, and the UI only mirrors it.
3. **Useful file handling.** Two workflows:
   - **Import** turns `.txt`, `.md` and `.docx` into editable documents, keeping Word pictures.
   - **Attachments** sit in the text where they're relevant: images inline, audio as a player, other files as chips.
4. **Real accounts, done safely.** Username + password with scrypt hashing, rate limits on guessing, and sessions that can actually be revoked.
5. **Quality you can check.** Validation, sanitization, 55 automated tests and one-command setup.

**Deliberately not built:** real-time co-editing, comments, version history, email (verification or reset), SSO and inline video. Each is a project of its own, and a half-built version would weaken the core.

## Shape of the system

```
Browser: React + TipTap (images, audio and file chips are editor nodes)
   │  JSON over fetch · httpOnly session cookie
   ▼
Express app (one process)
   ├── /api/auth                      sign-up, sign-in, sign-out, change password
   ├── /api/documents                 CRUD, sharing, import (mammoth / marked → sanitize)
   │     └── /:id/attachments         upload (type + content checks), list, download (ranges), delete
   └── static files                   built React app (prod) · Vite middleware (dev)
   ▼
Store (src/server/db.ts): the only module that runs SQL
   ▼
SQLite (WAL) on a Railway volume at /data
```

```
users            (id, username UNIQUE, name, color, password_hash, created_at)
sessions         (token, user_id → users, created_at, expires_at)
documents        (id, owner_id → users, title, content_html, version, …, updated_by)
document_shares  (document_id, user_id, role ∈ {viewer, editor})
attachments      (id, document_id → documents ON DELETE CASCADE, uploaded_by, filename, mime_type, size, sha256)
attachment_blobs (attachment_id → attachments ON DELETE CASCADE, data BLOB)
```

Migrations are numbered and tracked with SQLite's `user_version`. Migration 2 moved users from email to username + password. SQLite can't drop that column in place, so it rebuilds the table, keeping every id and checking foreign keys before committing. `tests/migration.test.ts` replays every migration on an old-format database.

## Key decisions

- **TipTap (ProseMirror) for the editor.** It gives a schema-backed document, so the HTML is consistent across browsers, plus shortcuts, Markdown input rules and undo. It's configured to exactly the formats the product supports.
- **Store sanitized HTML.** Imports produce HTML and any viewer can render it. Every write passes one allowlist (`sanitize.ts`) that mirrors the editor's schema. *Tradeoff:* comments anchored to text would fit ProseMirror JSON better.
- **Optimistic concurrency, plus 4-second polling.** Each save carries the `baseVersion` it was based on, and the database update only lands if that's still current. A stale save gets a 409, and the user picks *Load their version* or *Keep mine*. Polling shows others' changes when you have nothing unsaved. *Upgrade path:* Yjs and WebSockets for real co-editing.
- **Autosave is a plain class.** It's the code most prone to timing bugs (timers, races, retries), so it lives outside React (`lib/autosave.ts`) and is unit-tested with fake timers.
- **Username + password; server-side sessions.** Sharing needs a stable identity, not email. Sessions are random tokens stored in the database (not JWTs), so sign-out and a password change revoke them for real. *Tradeoff:* there's no self-service password reset without email.
- **Files are placed in the text by reference.** An image, audio player or chip is an editor node holding just the attachment id. It's saved as `<img>`, `<audio>` or `<a>` pointing at the attachment URL, so permissions still apply on every download, documents stay small, and the Attachments box can show what's used where.
- **Upload placeholders aren't content.** While a file uploads, its spot is a decoration whose position the editor tracks through edits. Autosave never stores a half-finished upload.
- **Deleting an embed keeps the file.** That way undo keeps working. Files are deleted only from the Attachments box, and any remaining reference shows "removed".
- **Attachments use the document's access.** There's no second permission system. An attachment id is only valid under its own document.
- **File bytes in SQLite, in their own table.** One backup covers everything, uploads are atomic, and deleting a document cascades to its files. *Tradeoff:* large media belongs in object storage (S3/R2), a change confined to the `Store` methods that read and write bytes.
- **`node:sqlite` and one deployable.** No native build and no database server, so setup is just `npm install`. One process means one port and no CORS. *Tradeoff:* a single instance on one volume.
- **A 404, not a 403, when you can't see a document,** so its existence isn't revealed.

## Security

- **Content:** every write is sanitized. Embeds survive only if they point at *this* document's attachments, which rules out tracking pixels, `data:` URIs and other documents' files. The production CSP (`script-src 'self'`) is a second layer.
- **Uploads:**
  - an allowlist of types (no HTML, SVG, scripts or programs)
  - the file's first bytes must match its extension
  - the server sets the Content-Type, with `nosniff`
  - downloads are `attachment`, except images and audio
  - a `sandbox` CSP on file responses
  - filenames cleaned and RFC 6266-encoded
  - size and count limits, and permission checked before the upload body is read
- **Accounts:**
  - scrypt with a per-user salt, with its parameters stored in the hash
  - 5 failed sign-ins per username and client per 15 minutes
  - IP limits on sign-in and sign-up
  - the same response and timing for a wrong password and an unknown user
  - all other sessions revoked on a password change
  - the shared demo accounts can't change their password
- **Requests:** zod validation, `httpOnly` + `SameSite=Lax` cookies (CSRF protection for the JSON API), `nosniff`, `X-Frame-Options: DENY`.

## What I'd do next

1. Real-time co-editing (Yjs) and presence
2. Password recovery, optional SSO, and invites for people without an account
3. Version history and comments anchored to text
4. Attachments in object storage with virus scanning, inline video, image resizing and captions
5. Export to `.docx`/PDF and import into an existing document
6. Playwright end-to-end tests, and rate limits in Redis for multiple instances

## Appendix: API

| Method & path | Who | Notes |
| --- | --- | --- |
| `POST /api/auth/register` | anyone | `{ name, username, password }`; signs in; 409 if the username is taken |
| `POST /api/auth/login` | anyone | `{ username, password }`; 401 on any mismatch, 429 when rate limited |
| `POST /api/auth/logout` · `GET /api/auth/me` | anyone | Logout deletes the session row |
| `POST /api/auth/password` | signed in | `{ currentPassword, newPassword }`; revokes other sessions |
| `GET /api/auth/config` | anyone | Whether to show the demo accounts |
| `GET /api/users?q=` | signed in | Share suggestions by username or name |
| `GET` · `POST /api/documents` | signed in | List as `{ owned, shared }` · create |
| `POST /api/documents/import` | signed in | Multipart → new document (`.docx` pictures become attachments) |
| `GET` · `PATCH` · `DELETE /api/documents/:id` | by role | 404 without access; `PATCH` needs `baseVersion` for content (409 if stale); delete is owner-only |
| `GET` · `PUT /api/documents/:id/shares` | read: anyone with access · change: owner | `PUT { username, role }` |
| `DELETE /api/documents/:id/shares/:userId` | owner, or that user | |
| `GET` · `POST /api/documents/:id/attachments` | read: access · upload: owner/editor | 415 type · 422 content mismatch · 413 over 10 MB · 409 over 20 |
| `GET` · `DELETE /api/documents/:id/attachments/:aid` | read: access · delete: owner/editor | Byte ranges (206/416), `ETag`, `?inline=1` for images and audio |

Errors always have the shape `{ error: { code, message, details? } }`. Validation errors name the offending field in `details.field`.
