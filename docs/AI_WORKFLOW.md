# AI workflow note

## Tools used

- **Claude Code** (Claude Opus 5.5, in the Claude desktop app) as a pair programmer. It planned the build, wrote the code, tests and docs, and ran checks. It also drove the app's built-in browser to click through flows as different users.
- No other AI tools.

## Decisions I made (not the AI)

- **Hosting:** I first chose Railway with a persistent volume, but Railway had paused new sign-ups. Render's free plan wipes its disk whenever the service sleeps. So the live demo runs on Vercel with a Turso database: free, persistent and always awake. The cost was moving the data layer from `node:sqlite` to libSQL (every query became async) and capping files at 4 MB to fit Vercel's request limit.
- **Accounts:** real sign-in with username + password instead of email. Sharing needs an identity, and email would add infrastructure for little gain. I stopped an email-based draft in favor of this.
- **Files:** attachments first, then placing files *inside* the document layout (images inline, audio players, file chips) rather than only a list under the page, and keeping video as a link until storage moves out of the database.
- **Where to stop:** no real-time co-editing, password reset or inline video within the timebox.

## Where AI materially sped things up

- **Scaffolding on brand-new major versions.** TypeScript 7, Vite 8, Vitest 5, Express 5, Zod 4 and TipTap 3 all have config or API changes from what most examples online show. Getting the server/client/test TypeScript setup and the one-port dev server (Vite as Express middleware) working took minutes, not an hour.
- **The test suite.** The API integration tests, fake-timer tests for autosave, and an in-memory `.docx` builder (so tests don't depend on binary fixtures) were drafted quickly, which made it cheap to test the risky paths rather than only the happy path.
- **Multi-user manual testing.** Testing sharing needs several people signed in at once. Using `localhost` and `127.0.0.1` as two origins gave two independent sessions in one browser. A small script played "Alice editing from another device" to exercise live updates and conflicts on demand.
- **CSS and documentation**, which are time-consuming but low-risk to delegate.

## What was changed or rejected

Verification caught several problems in the generated code:

| Problem | How it was found | Change |
| --- | --- | --- |
| Opening a document triggered a save. TipTap's `setEditable()` emits an update event, so viewers saw "Couldn't save" (a 403) and editors silently bumped the version on every open, which could cause false conflict warnings | Clicking through as Carol (viewer) in the browser | `setEditable(…, false)`, autosave ignores updates that don't change the content, and a regression test |
| Autosave notified the UI on every keystroke (a React re-render per key) | A unit test asserting the exact status sequence failed | Only notify on real status changes |
| The first sign-in page hard-coded the seeded accounts, duplicating the server seed | Review | Served from the API instead; later replaced by real accounts, with the demo list coming from `/api/auth/config` |
| Opening the share or account dialog put focus on its Close button: React's `autoFocus` ran before `showModal()`, which then moved focus itself | Browser testing (typing went nowhere) | Focus the input explicitly after the dialog opens |
| A style meant for the username in the account dialog also hit the avatar, washing out its initials | Screenshot review | Scoped the selector |
| The attachment upload response leaked the file's internal SHA-256 hash (used only for caching headers) | Reading the raw API response during browser testing | Stripped from responses, with a test asserting it's absent |
| `.docx` pictures were silently dropped on import: saving each picture opened a database transaction inside the import's transaction, SQLite refused, and a catch-all treated the error as "unsupported picture" | A new test expecting the imported picture | Only rule violations (not real errors) skip a picture. The import is now one atomic batch, so there's no nested transaction at all |
| Dropping an audio file and a video together lost the video's spot: inserting the player split the paragraph, and the editor discarded the placeholder sitting on the split | Browser test of a multi-file drop | Placeholder positions are tracked and mapped by hand, and files in one drop are placed one after another |
| Clicking *Insert* in the Attachments box replaced whatever was selected, deleting an image that happened to be selected | Browser test (the image vanished) | Inserting always goes after the selection and never replaces it |
| A combined rename + content save could half-apply if the content save hit a conflict | Review | The title and content are saved by one version-checked statement |
| The first Vercel deploy built, but the API crashed on start: `sanitize-html` `require()`s `htmlparser2`, which ships only ES modules. Node 22.12+ allows that, so every local test passed, but Vercel's runtime refuses it | Vercel's function logs | Reproduced locally by running Node with that feature off (`--no-experimental-require-module`). The API is now bundled for Vercel with esbuild, which resolves those imports at build time. Downgrading `sanitize-html` was rejected: every release after 2.17.1 has the same dependency |
| Moving to an async database made the 20-file limit racy: the count was checked, then the file inserted, and two uploads could both pass the check | Review during the libSQL conversion | The count is checked inside the insert itself, with a test racing three uploads for the last slot |
| Clicking a page's margin didn't put the cursor in the document | Browser testing | Margin clicks focus the editor |
| One 656 KB JS bundle | Build output | The editor is lazy-loaded; the first page is now 75 KB gzipped |

Approaches considered and rejected:

- **Real-time co-editing (Yjs/CRDT):** the right long-term answer, but a WebSocket server and CRDT persistence don't fit the timebox. Optimistic concurrency plus polling covers the "don't lose work" requirement honestly.
- **`react-router`:** two routes don't justify a dependency, so there's a 20-line router instead.
- **`better-sqlite3`:** needs a native build. The app first used Node's built-in `node:sqlite`, then libSQL (prebuilt binaries, and the same SQL locally and on Turso) once hosting moved to serverless.
- **Postgres (Neon, Supabase) for production:** would have meant rewriting every query and migration in another dialect. Turso keeps SQLite, so the local and hosted databases behave the same.
- **Vercel Blob for files:** would lift the 4 MB cap, but adds a second store, signed upload URLs and cleanup across both. Out of scope for the timebox; it's in the architecture note's next steps.
- **Storing ProseMirror JSON:** HTML fits import/export better. The reasoning is in the architecture note.
- **Email-based accounts** (verification links, password reset, invites by email): an AI draft of this was started. It was cut back to username + password, which is all sharing needs, and kept only its scrypt hashing and rate limiter. Email would add a sending provider, deliverability and more flows to secure, for little gain here.
- **bcrypt or argon2:** both need native add-ons. scrypt is built into Node and is also memory-hard.

## How correctness, UX and reliability were verified

- **Types:** strict TypeScript (including `noUncheckedIndexedAccess`) across server, client and tests.
- **Automated tests (58):**
  - files embedded in the text: round-trips, stripping of hostile or foreign embeds, byte ranges, `.docx` pictures
  - attachments: exact-byte downloads, safe headers, permissions at every role, disguised and oversized files, cleanup on delete
  - sign-up, sign-in, lockout, session revocation and password change
  - upgrading an existing database to accounts without losing data (also rehearsed on a copy of the real local database before the app touched it)
  - a new database getting exactly the schema the migrations produce
  - access control at each role
  - XSS stripping
  - version conflicts
  - all three import formats plus bad inputs
  - autosave timing, ordering, retry and conflict behavior
- **Production build, clicked through in a real browser** as Alice, Bob and Carol:
  - create → rename → format → reload, comparing the editor HTML before and after reload (identical)
  - creating an account (with validation errors), a wrong password, changing the password and signing back in with it
  - share dialog: finding a new user by typing part of their username (the unknown-username error is covered by the API tests)
  - attachments: five files picked at once through the real file input, uploading one after another; a `.exe` refused in the browser and a program renamed to `.pdf` refused by the server; downloads checked byte-for-byte (including a filename with a non-ASCII dash); image thumbnail; a view-only user seeing a new file appear without refreshing, with no add or remove controls; removal; phone width
  - files in the text: an image via the toolbar, a pasted screenshot and a pasted chart landing at the cursor, a multi-file drop (PDF, MP3, MP4) landing in order, upload placeholders appearing and clearing, *Insert* from the Attachments box, the "In text" marks, a removed file showing "removed" in place, everything surviving a reload (checked in the stored HTML), and a view-only user seeing players and chips with no editing controls
  - view-only mode
  - another user's edit appearing live
  - a forced edit conflict and its resolution
  - `.docx` and unsupported-file import through the real file input
  - phone width with no horizontal scrolling
  - browser console and server logs free of unexpected errors
- **Separating tool quirks from app bugs.** Some odd results came from the browser automation, not the app:
  - it inserts text in one go, so Markdown shortcuts like `## ` don't fire
  - background tabs pause `requestAnimationFrame`, so focus changes are delayed

  These were confirmed by inspecting the DOM directly before deciding whether to change code.
- **The Vercel function, run locally.** The built `api/index.js` was run behind a plain Node HTTP server against a throwaway database, with Node's `require()` of ES modules turned off to match Vercel's runtime: 19 checks, including the "database not configured" message, sign-in, a combined rename + save, a stale save, uploads and byte-exact downloads up to 3.98 MB, a refused 4 MB+ file and a `.docx` import with its picture. A copy of the real local database was also opened with the new driver to confirm nothing was lost.
- **Not verified locally:**
  - the Turso connection itself (HTTPS rather than a local file; same queries), and Vercel's build and routing. The first deploy checks both.
  - the Docker image build (no Docker on the build machine).
- **A test-only quirk:** after the switch to libSQL, tests couldn't delete their temporary database folders on Windows, because a closed database keeps its file open until garbage collection. The tests now collect garbage before cleaning up. It doesn't affect the app.
