# Ajaia Docs

> A copy of the project's top-level `README.md`, kept here so all the notes are in one folder. The top-level file is the original.

A lightweight collaborative document editor: create an account, create and format documents in the browser, import `.txt` / `.md` / `.docx` files, and share documents with other people as viewers or editors.

**Live demo:** **https://ajaia-docs-j51s.vercel.app**. Hosted on Vercel, with the data in a Turso database, so everything you create stays (see [Deploy](#deploy-to-vercel-with-turso)).

- [Submission summary](SUBMISSION.md): exactly what's included, and where each requirement is met
- [Architecture note](ARCHITECTURE.md): what I prioritized and why
- [AI workflow note](AI_WORKFLOW.md): how AI tools were used and checked
- [Screenshots](screenshots/)

![The editor with a Word import, file chips and an audio player](screenshots/03-editor-with-files.png)

---

## Two-minute tour for reviewers

Sign in with a username and password. Create your own account on the **Create account** tab, or use one of the three shared demo accounts. Their password is **`ajaia-demo`**, and the sign-in page has one-click buttons that fill it in.

| Username | What they have |
| --- | --- |
| **alice** (Alice Chen) | Owns **Q4 Launch Plan**, shared with Bob (can edit) and Carol (can view) |
| **bob** (Bob Okafor) | Can edit Alice's plan; owns a private draft |
| **carol** (Carol Diaz) | Can only view Alice's plan |

1. **Sign in as alice.** "My documents" and "Shared with me" are separate lists; owned documents show *Private* or *Shared with N*.
2. **Open Q4 Launch Plan** and edit it: headings, bold/italic/underline/strikethrough, bulleted and numbered lists, quotes. Markdown shortcuts work too (`## `, `- `, `1. `, `**bold**`). The header shows *Saving… / Saved*. Refresh the page and the content and formatting are still there.
3. **Click Share** and give Bob or Carol access, or change/revoke a role. Start typing a username or name to get suggestions.
4. **Open a private window and sign in as carol.** The shared document opens read-only with a banner. Edits Alice makes appear in Carol's view within a few seconds.
5. **Create your own account** in another private window, then share a document with it from Alice's account. In your account (click your name, top right) you can change your password, which signs out your other devices.
6. **Put files in the text:** paste or drop an image, PDF, audio clip or any other allowed file right into the document, or use the image and paperclip buttons at the end of the toolbar.
   - Images appear inline, audio gets a player, and everything else becomes a clickable file chip at that spot.
   - A placeholder with a progress bar holds the spot while each file uploads.
   - The **Attachments** box below the page lists every file, marks the ones used in the text, and can *Insert* the others at the cursor. Dropping a file on the box attaches it without placing it.
   - Sign in as carol to see a view-only person play and download them without being able to change anything.
7. **Import a file** from the home page (button or drag and drop) to turn it into a new editable document. Try the files in [`samples/import`](../samples/import/).

Ready-made test files for every upload path live in [`samples/`](../samples/README.md): files that should import, files that should attach (images, audio, PDF, Office, ZIP), and files that should be refused (programs, scripts, disguised and oversized files). [`samples/README.md`](../samples/README.md) says what each one checks and what you should see.
8. **Try a conflict:** open the same document as Alice and Bob in two windows and edit both. The second save is rejected instead of silently overwriting, and you choose *Load their version* or *Keep mine*.

## What's included

| Requirement | Implementation |
| --- | --- |
| Accounts | Sign up, sign in and sign out with **username + password**. Change password (signs out other devices). Passwords hashed with scrypt; failed sign-ins rate limited; 7-day sessions in an `httpOnly` cookie |
| Create / rename / edit / save / reopen | New document button, inline title rename, TipTap rich-text editor, debounced autosave (plus Ctrl/Cmd+S), documents persist in the database |
| Rich text | Bold, italic, underline, strikethrough, Normal/H1/H2/H3, bulleted and numbered lists, block quotes, undo/redo, clear formatting |
| File upload: attachments | Files live *in the text* where they're relevant: inline images, audio players, and file chips for everything else (video, PDF, Office, ZIP). Paste, drop or toolbar insert, with an upload placeholder in place. Up to 4 MB each, 20 per document. An Attachments box indexes every file. Access follows the document's sharing (viewers view and download; owners and editors add, place and remove). Files whose contents don't match their extension are refused |
| File upload: import | Import `.txt`, `.md`, `.docx` (max 4 MB) as a **new editable document**. Unsupported types are rejected with a clear message in the UI and API |
| Sharing | Owner + per-user roles (**viewer** / **editor**), enforced on the server. Owners share **by username** (with suggestions as you type), change roles and revoke access; documents nobody shared with you return 404 |
| Owned vs shared | Separate "My documents" / "Shared with me" sections with owner and role badges; role shown in the editor header |
| Persistence | SQLite through libSQL: a local file in development, a [Turso](https://turso.tech) database in production. Schema migrations, sanitized HTML content, multi-row writes in atomic batches |
| Quality | Input validation (zod) with field-level errors, consistent JSON errors, upload limits, HTML sanitization, CSP, 58 automated tests |

### Attachments

| | Allowed |
| --- | --- |
| Documents | `.pdf` `.doc` `.docx` `.odt` `.rtf` |
| Spreadsheets | `.xls` `.xlsx` `.ods` `.csv` |
| Presentations | `.ppt` `.pptx` `.odp` |
| Text | `.txt` `.md` |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` (shown in the text) |
| Audio | `.mp3` `.m4a` `.wav` `.ogg` (an inline player, with seeking) |
| Video | `.mp4` `.webm` `.mov` (a downloadable file chip; see Known limitations) |
| Archives | `.zip` |

Anything else is refused with a message listing what's allowed. That includes programs, scripts, HTML and SVG, which can carry code. The server also checks each file's first bytes, so a program renamed to `invoice.pdf` is rejected.

Files are served as downloads, never opened inside the app. Images and audio are the only inline exceptions, so a shared file can't run code in someone else's session. The text can only embed this document's own files: images from other websites (often used to track who opens a document), `data:` images, and files from other documents are stripped when the document is saved.

Deleting an image or chip from the text doesn't delete the file. Undo keeps working, and the file stays in the Attachments box. Removing a file from the box leaves a "removed" marker wherever it was used.

### Supported import formats

| Type | What's kept | What's dropped |
| --- | --- | --- |
| `.txt` | Paragraphs (blank lines), line breaks | n/a |
| `.md` | Headings, bold/italic, lists, quotes, code, links | Images, tables, raw HTML outside the allowlist |
| `.docx` | Headings, paragraphs, bold/italic/underline/strikethrough, lists, **pictures** (PNG/JPG/GIF/WebP become attachments embedded where they were) | Other picture formats (e.g. EMF), tables (their text is kept), comments, page layout |

H4 to H6 become H3 (the editor has three heading levels). Legacy `.doc`, PDF and other formats aren't supported.

## Run locally

Requires **Node.js 22.13+** (Node 24 LTS recommended). There's no database to install: locally the app keeps its data in a SQLite file, using libSQL's prebuilt driver (nothing to compile).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. The dev server runs the API and Vite (with hot reload) on one port. The database is created at `data/ajaia-docs.db` and seeded on first start. Stop the server and delete the `data/` folder to reset.

An existing database from the earlier email-based demo is upgraded automatically on start. Users keep their documents and shares, their username becomes the part of their old email before `@`, and everyone signs in again.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Runs the test suite (Vitest) |
| `npm run typecheck` | Type-checks the server, client and tests |
| `npm run build` | Builds the client into `dist/client` and the server into `dist/server` |
| `npm run build:vercel` | `build`, plus the API bundled into one file for Vercel (`dist/vercel/server.mjs`) |
| `npm start` | Runs the production build (`node dist/server/index.js`) |
| `npm run samples` | Regenerates the test files in `samples/` (including the large ones, which aren't committed) |

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/ajaia-docs.db` | SQLite file location (when no Turso URL is set) |
| `TURSO_DATABASE_URL` | none | A Turso database (`libsql://…`). When set, it's used instead of the local file |
| `TURSO_AUTH_TOKEN` | none | The token for that database |
| `DEMO_ACCOUNTS` | `true` | Create the shared demo accounts (alice, bob, carol) and show them on the sign-in page. Set to `false` for real use: their password is public |

## Deploy to Vercel (with Turso)

Vercel runs the API as a serverless function and serves the React app from its CDN. Serverless functions have no lasting disk, so the data lives in [Turso](https://turso.tech), a hosted SQLite database with a free plan. The app runs the same queries against a local file and against Turso.

**1. Create the database** (Turso, free):
1. Sign up at [turso.tech](https://turso.tech) (GitHub sign-in works).
2. In the dashboard, create a database (for example `ajaia-docs`) in a region near your Vercel region (Vercel defaults to Washington, D.C., `iad1`, so pick a US East region).
3. On the database's page, copy its **URL** (`libsql://ajaia-docs-<you>.<region>.turso.io`) and create a **token** with read and write access. Keep both for step 2.

The app creates its tables, demo accounts and sample documents on first start.

**2. Deploy** (Vercel, free Hobby plan):
1. In Vercel, choose **Add New → Project** and import this GitHub repository. `vercel.json` already sets the build (`npm run build:vercel`), the output folder (`dist/client`) and the routes, so leave the build settings as they are.
2. Under **Environment Variables**, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` with the values from step 1.
3. Click **Deploy**. When it finishes, open the `*.vercel.app` URL and sign in as a demo account, or create one.

If you deployed before adding the variables, add them under **Settings → Environment Variables** and redeploy. Until then the API answers with a message saying what's missing.

How it fits together:
- `api/index.js` is the one serverless function. It loads the Express app once per instance and passes each `/api/*` request to it.
- The app is bundled into one file, `dist/vercel/server.mjs`, by `scripts/build-vercel.mjs` (esbuild). Vercel's Node runtime can't `require()` packages that ship only ES modules, which Node itself allows and which `sanitize-html` relies on. Bundling resolves those imports at build time.
- `vercel.json` sends `/api/*` to that function, every other path to the React app, and sets the same security headers the Express server sets.
- **Files are limited to 4 MB**, because a Vercel function accepts at most 4.5 MB per request and response.

**Other hosts:** the `Dockerfile` runs the whole app as one Node server (`npm start`) anywhere Docker runs. Without a Turso URL it keeps a SQLite file at `/data/ajaia-docs.db`, so mount a persistent volume there. `render.yaml` (Render) and `railway.json` (Railway) are included for those hosts. On Render's free plan the disk resets when the service sleeps, unless `TURSO_DATABASE_URL` is set.

## Tests

`npm test` runs 58 tests (a few seconds):

- **Embedding tests** (`tests/embedding.test.ts`):
  - images, audio and file chips survive save → reopen
  - tracking pixels, `data:` images, other documents' files, mismatched ids and bad chip data are stripped, while ordinary links are kept
  - byte-range (206/416) responses for media seeking
  - audio plays inline but video doesn't
  - a `.docx` picture becomes an embedded attachment in the right place
- **Attachment tests** (`tests/attachments.test.ts`):
  - upload → list → download returns the exact bytes, with download-only, sandboxed headers
  - ETag revalidation (304)
  - non-English and path-traversal filenames
  - permissions at every role (viewer read-only; no access = 404; ids can't be used across documents)
  - unsupported, disguised (`.exe` renamed to `.pdf`, HTML renamed to `.png`), empty and oversized files
  - images-only inline display
  - the 20-file limit, including several uploads racing for the last slot
  - files deleted along with their document
- **Account tests** (`tests/auth.test.ts`):
  - sign-up stores only a salted hash
  - usernames are unique regardless of case
  - every validation rule
  - a wrong password and an unknown username get identical answers
  - lockout after 5 failed sign-ins, reset by a success
  - signed-out and expired sessions are rejected
  - changing the password needs the current one and revokes other sessions but not this one
  - demo passwords can't be changed
  - user search
- **Database tests** (`tests/migration.test.ts`):
  - an email-era database is upgraded through every migration with every document, share and author intact, and foreign keys still enforced
  - a brand-new database gets exactly the schema the migrations produce
  - reopening and reseeding changes nothing
  - a database from before the version table existed opens without redoing any step
- **API integration tests** (`tests/api.test.ts`, Supertest against an in-memory database):
  - auth required
  - create → rename → save → reopen keeps formatting
  - XSS payloads are stripped
  - stale saves get a 409
  - the full sharing lifecycle (private → viewer can't edit/reshare/delete → editor can edit → revoke)
  - Markdown / text / `.docx` import
  - rejection of unsupported, empty, corrupt and oversized files
- **Autosave unit tests** (`tests/autosave.test.ts`, fake timers):
  - debouncing
  - never two saves in flight
  - conflict handling
  - retry with backoff
  - no-op updates ignored (regression test for a bug found in browser testing)

The `.docx` fixtures are built in memory (`tests/helpers/docx.ts`), so there are no binary files in the repo.

## Project structure

```
src/
  server/          Express API
    app.ts         app factory (routes, security headers, error handling)
    db.ts          Store: all SQL, migrations, access checks (libSQL: local file or Turso)
    auth.ts        sign-up, sign-in, sign-out, change password, sessions
    password.ts    scrypt hashing and verification
    rateLimit.ts   in-memory limits for sign-in and sign-up attempts
    documents.ts   documents, sharing and import routes
    attachments.ts attachment upload, list, download and delete routes
    uploads.ts     upload handling: size limits, safe filenames, content checks
    importFile.ts  .txt / .md / .docx → sanitized HTML
    sanitize.ts    HTML allowlist shared by saves and imports
    index.ts       production entry for Docker/`npm start` (serves API + built client)
    vercel.ts      Vercel entry (API only; Vercel serves the client)
    dev.ts         dev entry (API + Vite middleware)
  client/          React app
    pages/         Sign in / create account, Documents, Editor
    editor/        embeds (image, audio, file chip), upload placeholders, attachments context
    components/    Toolbar, AttachmentsPanel, ShareDialog, AccountDialog, form fields, header, toasts
    lib/           API client, autosave, form validation, tiny router
  shared/          types, account rules and attachment rules shared by client and server
api/index.js       the Vercel serverless function (loads the bundle made by scripts/build-vercel.mjs)
tests/             embedding, attachment, account, database, API and autosave tests
samples/           test files: import/, attach/, should-fail/ (guide in samples/README.md)
docs/              architecture and AI workflow notes
```

## Known limitations

- **Not real-time co-editing.** Concurrent edits are detected (version check) rather than merged, and other people's changes show up by polling every 4 seconds. See the architecture note for the upgrade path (Yjs).
- **No password reset.** There's no email, so a forgotten password can't be recovered by the user. An admin reset or email-based reset would be next.
- **The demo accounts' password is public** by design. Turn them off with `DEMO_ACCOUNTS=false` for anything real.
- **Rate limits live in memory.** On Vercel each function instance keeps its own count, and counts reset when an instance is recycled, so the sign-in limits are weaker there than on a single server. A shared store (Redis, or a table in the database) would fix that.
- **Import creates a new document**; it doesn't merge into an existing one. Tables aren't imported (their text is).
- **Files are capped at 4 MB,** because Vercel functions accept at most 4.5 MB per request. Larger files would upload straight to object storage (S3 or R2) through signed URLs, bypassing the function.
- **Video is a file chip, not an inline player.** At 4 MB a video is only seconds long, and large media belongs in object storage rather than the database. With that in place, an inline player is a small change, since byte ranges already work.
- **Images can't be resized or captioned** in the editor yet.
- **Attachments live inside the database.** That's simple and safe at this scale (one backup covers everything, and nothing is left orphaned), but large volumes of files belong in object storage. Only the attachment methods in `Store` that read or write file bytes would change.
- **No virus scanning** of attachments beyond the type and content checks.
