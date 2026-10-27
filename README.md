# Ajaia Docs

A lightweight collaborative document editor: create an account, create and format documents in the browser, import `.txt` / `.md` / `.docx` files, and share documents with other people as viewers or editors.

**Live demo:** _URL added after deployment (see [Deploy](#deploy-to-render))_. Hosted on Render's free plan: the first visit after a quiet spell takes 30–60 seconds to wake the server, and data resets when it sleeps.

- [Submission summary](SUBMISSION.md): exactly what's included, and where each requirement is met
- [Architecture note](docs/ARCHITECTURE.md): what I prioritized and why
- [AI workflow note](docs/AI_WORKFLOW.md): how AI tools were used and checked
- [Screenshots](docs/screenshots/)

![The editor with a Word import, file chips and an audio player](docs/screenshots/03-editor-with-files.png)

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
7. **Import a file** from the home page (button or drag and drop) to turn it into a new editable document. Try the files in [`samples/import`](samples/import/).

Ready-made test files for every upload path live in [`samples/`](samples/README.md): files that should import, files that should attach (images, audio, PDF, Office, ZIP), and files that should be refused (programs, scripts, disguised and oversized files). [`samples/README.md`](samples/README.md) says what each one checks and what you should see.
8. **Try a conflict:** open the same document as Alice and Bob in two windows and edit both. The second save is rejected instead of silently overwriting, and you choose *Load their version* or *Keep mine*.

## What's included

| Requirement | Implementation |
| --- | --- |
| Accounts | Sign up, sign in and sign out with **username + password**. Change password (signs out other devices). Passwords hashed with scrypt; failed sign-ins rate limited; 7-day sessions in an `httpOnly` cookie |
| Create / rename / edit / save / reopen | New document button, inline title rename, TipTap rich-text editor, debounced autosave (plus Ctrl/Cmd+S), documents persist in SQLite |
| Rich text | Bold, italic, underline, strikethrough, Normal/H1/H2/H3, bulleted and numbered lists, block quotes, undo/redo, clear formatting |
| File upload: attachments | Files live *in the text* where they're relevant: inline images, audio players, and file chips for everything else (video, PDF, Office, ZIP). Paste, drop or toolbar insert, with an upload placeholder in place. Up to 10 MB each, 20 per document. An Attachments box indexes every file. Access follows the document's sharing (viewers view and download; owners and editors add, place and remove). Files whose contents don't match their extension are refused |
| File upload: import | Import `.txt`, `.md`, `.docx` (max 5 MB) as a **new editable document**. Unsupported types are rejected with a clear message in the UI and API |
| Sharing | Owner + per-user roles (**viewer** / **editor**), enforced on the server. Owners share **by username** (with suggestions as you type), change roles and revoke access; documents nobody shared with you return 404 |
| Owned vs shared | Separate "My documents" / "Shared with me" sections with owner and role badges; role shown in the editor header |
| Persistence | SQLite (Node's built-in `node:sqlite`), schema migrations, sanitized HTML content, WAL mode |
| Quality | Input validation (zod) with field-level errors, consistent JSON errors, upload limits, HTML sanitization, CSP, 55 automated tests |

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

Requires **Node.js 22.13+** (Node 24 LTS recommended). There's no database to install: SQLite is built into Node.

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
| `npm start` | Runs the production build (`node dist/server/index.js`) |
| `npm run samples` | Regenerates the test files in `samples/` (including the large ones, which aren't committed) |

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/ajaia-docs.db` | SQLite file location |
| `DEMO_ACCOUNTS` | `true` | Create the shared demo accounts (alice, bob, carol) and show them on the sign-in page. Set to `false` for real use: their password is public |

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aimaster-dev/ajaia-docs)

The repo includes a `Dockerfile` and a Render Blueprint, `render.yaml`. The Blueprint sets up a Docker web service on the free plan, with a health check on `/api/health`.

1. Click the button above, or in the Render dashboard choose **New → Blueprint** and pick this repository.
2. Click **Apply**. Render builds the Docker image, which takes a few minutes the first time.
3. When the service shows **Live**, open its `onrender.com` URL and sign in as a demo account, or create one. Demo accounts and sample documents are created automatically on every start.

No environment variables are required: the image sets `DATABASE_PATH=/data/ajaia-docs.db`, and Render supplies `PORT`.

**Free plan limits:**
- The service sleeps after 15 minutes without traffic, and its disk is reset when it sleeps or restarts.
- Anything people create is gone after that, but the demo data comes back.

**To keep data:** switch the service to a paid plan and add a **disk** mounted at **`/data`** (the commented-out `disk` block in `render.yaml`). Attachments are stored in the database file, so size the disk for the files you expect.

**Run it as a single instance,** since SQLite lives on one disk.

**Other hosts:** any Docker host with a persistent volume at `/data` works the same way. `railway.json` is included for Railway, which was paused for new sign-ups when this was built.

## Tests

`npm test` runs 55 tests (about 10–20 seconds, mostly the large-upload tests):

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
  - the 20-file limit
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
- **Upgrade tests** (`tests/migration.test.ts`): an email-era database is upgraded through every migration with every document, share and author intact, and foreign keys still enforced.
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
    db.ts          Store: all SQL, migrations, access checks
    auth.ts        sign-up, sign-in, sign-out, change password, sessions
    password.ts    scrypt hashing and verification
    rateLimit.ts   in-memory limits for sign-in and sign-up attempts
    documents.ts   documents, sharing and import routes
    attachments.ts attachment upload, list, download and delete routes
    uploads.ts     upload handling: size limits, safe filenames, content checks
    importFile.ts  .txt / .md / .docx → sanitized HTML
    sanitize.ts    HTML allowlist shared by saves and imports
    index.ts       production entry (serves API + built client)
    dev.ts         dev entry (API + Vite middleware)
  client/          React app
    pages/         Sign in / create account, Documents, Editor
    editor/        embeds (image, audio, file chip), upload placeholders, attachments context
    components/    Toolbar, AttachmentsPanel, ShareDialog, AccountDialog, form fields, header, toasts
    lib/           API client, autosave, form validation, tiny router
  shared/          types, account rules and attachment rules shared by client and server
tests/             embedding, attachment, account, upgrade, API and autosave tests
samples/           test files: import/, attach/, should-fail/ (guide in samples/README.md)
docs/              architecture and AI workflow notes
```

## Known limitations

- **Not real-time co-editing.** Concurrent edits are detected (version check) rather than merged, and other people's changes show up by polling every 4 seconds. See the architecture note for the upgrade path (Yjs).
- **No password reset.** There's no email, so a forgotten password can't be recovered by the user. An admin reset or email-based reset would be next.
- **The demo accounts' password is public** by design. Turn them off with `DEMO_ACCOUNTS=false` for anything real.
- **Rate limits live in memory**, so they reset on restart and wouldn't be shared across several instances.
- **Import creates a new document**; it doesn't merge into an existing one. Tables aren't imported (their text is).
- **Video is a file chip, not an inline player.** At 10 MB a video is barely a minute, and large media should live in object storage rather than the database. With that in place, an inline player is a small change, since byte ranges already work.
- **Images can't be resized or captioned** in the editor yet.
- **Attachments live inside the SQLite file.** That's simple and safe at this scale (one backup covers everything, and nothing is left orphaned), but large volumes of files belong in object storage such as S3 or R2. Only the attachment methods in `Store` that read or write file bytes would change.
- **No virus scanning** of attachments beyond the type and content checks.
- **Single instance:** SQLite on one volume. Moving to Postgres is contained to `src/server/db.ts`.
