# Test files

Files for trying every upload path by hand: what should work, and what should be refused (and why). Regenerate them with `npm run samples`. The three images in `attach/` are static.

Demo sign-in: **alice**, **bob** or **carol**, password `ajaia-demo`.

## `import/`: turn a file into a new document

On the home page, click **Import file** (or drop the file anywhere on the page). Each import opens as a new document.

| File | What it checks | You should see |
| --- | --- | --- |
| `meeting-notes.md` | Markdown basics | Headings, bold/italic, bulleted and numbered lists, a quote |
| `plain-notes.txt` | Plain text | Blank lines become paragraphs; single line breaks are kept |
| `formatting-showcase.md` | Every format, plus hostile content | H4 becomes H3; strikethrough, code and links kept; table cells keep their text (no table layout); the remote image, the `<script>` and the `onclick` are removed |
| `project-brief.docx` | Word formatting | Heading 1/2, **bold**, *italic*, underline |
| `report-with-chart.docx` | Pictures in Word files | The bar chart appears where it was in the Word file and is listed in the Attachments box as `image-1.png` |

## `attach/`: files in a document

Open a document you can edit, then try any of these:
- **Place it in the text:** paste it (Ctrl+V), drop it on the text, or use the **image** / **paperclip** buttons at the end of the toolbar. A placeholder with progress holds the spot while it uploads.
- **Just attach it:** drop it on the **Attachments** box below the page, or use *Add files* there. Use the row's *Insert* button to place it later.

| File | Shows in the text as |
| --- | --- |
| `q4-signups-chart.png` | Image |
| `team-offsite.jpg` | Image |
| `ajaia-logo.gif` | Image |
| `launch-jingle.wav` | Audio player (a 3-second jingle you can play and seek) |
| `q4-budget.pdf` | File chip; click to download |
| `budget.xlsx`, `budget.csv` | File chip (spreadsheet icon) |
| `project-brief.docx` | File chip (document icon) |
| `release-notes.md`, `meeting-transcript.txt` | File chip (text icon) |
| `design-assets.zip` | File chip (archive icon) |

Things to try with them:
- Select several files at once. They upload one after another and land in the order you picked them.
- Remove a file in the Attachments box. Where it was used, the text shows "removed".
- Sign in as **carol**: she can play and download everything but has no add, insert or remove controls. In the demo data she can only view Alice's Q4 Launch Plan.

## `should-fail/`: each one is refused, with a different reason

| File | Try it as | Refused because | Caught by |
| --- | --- | --- | --- |
| `setup.exe` | attachment / import | Programs aren't an allowed type | Browser, before uploading |
| `logo.svg` | attachment | SVG can carry script | Browser |
| `page.html` | attachment | HTML can carry script | Browser |
| `notes-without-extension` | attachment | No file type at all | Browser |
| `invoice.pdf` | attachment | It's really a program, renamed to `.pdf` | **Server** (checks the file's first bytes) |
| `photo.png` | attachment | It's really a web page, renamed to `.png` | **Server** |
| `song.mp3` | attachment | It's really text, renamed to `.mp3` | **Server** |
| `corrupt.docx` | attachment / import | Not a real Word file | **Server** |
| `binary-notes.txt` | attachment / import | Binary data posing as text | **Server** |
| `empty.txt` | attachment / import | The file is empty | Browser |
| `too-big-attachment.pdf` | attachment | 10.5 MB, over the 10 MB limit | Browser (server too) |
| `too-big-import.txt` | import | 6 MB, over the 5 MB import limit | Browser (server too) |
| `invoice.pdf` | import | PDF isn't an import format (attach it instead) | Browser |

The two `too-big-*` files are generated but not committed (see `.gitignore`). Run `npm run samples` to create them.

## Not included

Real MP3/M4A/OGG audio, WebP images and MP4/WebM/MOV video need an encoder to create, so they aren't generated here. Any short file from your phone (under 10 MB) works the same. Audio gets a player; video becomes a file chip.
