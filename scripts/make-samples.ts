// Generates the test files in samples/ (see samples/README.md for what each one checks).
// Run with: npm run samples
//
// The three images in samples/attach (PNG, JPG, GIF) are static files drawn once
// with Windows' System.Drawing; this script reads the PNG to embed it in a .docx.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { makeDocx } from '../tests/helpers/docx.js';

const IMPORT = 'samples/import';
const ATTACH = 'samples/attach';
const FAIL = 'samples/should-fail';
for (const dir of [IMPORT, ATTACH, FAIL]) mkdirSync(dir, { recursive: true });

const written: string[] = [];
const write = (path: string, data: string | Buffer) => {
  writeFileSync(path, data);
  written.push(path);
};

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chartPath = `${ATTACH}/q4-signups-chart.png`;
const chart = existsSync(chartPath) ? readFileSync(chartPath) : null;
if (!chart) console.warn(`! ${chartPath} is missing: skipping the files that embed it.`);

// ---- builders ------------------------------------------------------------------

/** A real one-page PDF (Helvetica text), with a correct cross-reference table. */
function makePdf(lines: { text: string; size: number; y: number }[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = lines.map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${esc(l.text)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A real, playable 16-bit mono WAV: a short rising jingle. */
function makeWav(notes: [frequency: number, seconds: number][], sampleRate = 22050): Buffer {
  const samples: number[] = [];
  for (const [freq, seconds] of notes) {
    const n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n; i++) {
      const envelope = Math.min(1, i / 300) * Math.min(1, (n - i) / 1200); // no clicks
      samples.push(freq ? Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.35 * envelope : 0);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM header size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A minimal but valid Excel workbook (one sheet, inline strings, one formula). */
async function makeXlsx(sheetName: string, rows: (string | number | { formula: string })[][]): Promise<Buffer> {
  const col = (i: number) => String.fromCharCode(65 + i);
  const cell = (v: string | number | { formula: string }, r: number, c: number) =>
    typeof v === 'number'
      ? `<c r="${col(c)}${r}"><v>${v}</v></c>`
      : typeof v === 'object'
        ? `<c r="${col(c)}${r}"><f>${v.formula}</f></c>`
        : `<c r="${col(c)}${r}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  const sheet =
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r + 1, c)).join('')}</row>`).join('') +
    '</sheetData></worksheet>';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  );
  zip.file('xl/worksheets/sheet1.xml', sheet);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Looks like a Windows program (starts with "MZ"). Harmless: it's not runnable. */
const fakeProgram = () =>
  Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), Buffer.from('This program cannot be run in DOS mode.\r\n'), Buffer.alloc(200)]);

// ---- import/: files that should become editable documents --------------------------

write(
  `${IMPORT}/meeting-notes.md`,
  `# Design review – editor beta

Attendees: Alice, Bob, Carol

## Decisions

- Ship **autosave** with a visible save status
- Keep sharing to *two roles* for now: viewer and editor
- Import supports .txt, .md and .docx

## Next steps

1. Bob writes the rollout note
2. Carol checks the import on real customer files
3. Alice books the follow-up

> Open question: do we need comments before beta?
`,
);

write(
  `${IMPORT}/plain-notes.txt`,
  `Quick notes from the customer call

They want to paste in docs from Word and keep headings.
Sharing should be simple: one person owns it, others can view or edit.

Follow up next Tuesday.
`,
);

write(
  `${IMPORT}/formatting-showcase.md`,
  `# Heading 1
## Heading 2
### Heading 3
#### Heading 4 (becomes Heading 3: the editor has three levels)

Text with **bold**, *italic*, ~~strikethrough~~, \`inline code\` and a [link to example.com](https://example.com).

- Bullet one
- Bullet two
  - A nested bullet

1. First
2. Second

> A block quote.

\`\`\`
A code block
  keeps its spacing
\`\`\`

| Table | Cells keep their text |
| ----- | --------------------- |
| but   | the table layout goes |

![A remote image that is removed](https://example.com/tracking-pixel.png)

<script>alert('This script must not survive import')</script>
<p onclick="alert('nor this handler')">This paragraph stays, without its onclick.</p>
`,
);

const brief = await makeDocx([
  { style: 'Heading1', runs: ['Project brief: Ajaia Docs'] },
  { runs: ['This brief was written in ', { text: 'Microsoft Word', bold: true }, ' and imported as an editable document.'] },
  { style: 'Heading2', runs: ['Goals'] },
  { runs: ['Help teams move faster on ', { text: 'shared', italic: true }, ' work.'] },
  { style: 'Heading2', runs: ['Constraints'] },
  { runs: [{ text: 'Timebox:', underline: true }, ' four to six hours.'] },
]);
write(`${IMPORT}/project-brief.docx`, brief);

if (chart) {
  write(
    `${IMPORT}/report-with-chart.docx`,
    await makeDocx([
      { style: 'Heading1', runs: ['Q4 growth report'] },
      { runs: ['Sign-ups grew every month this quarter. The chart below comes from the Word file itself:'] },
      { runs: [{ image: chart, alt: 'Bar chart of Q4 sign-ups by week' }] },
      { style: 'Heading2', runs: ['What drove it'] },
      { runs: [{ text: 'Sharing', bold: true }, ' and the new ', { text: 'import', italic: true }, ' flow.'] },
    ]),
  );
}

// ---- attach/: files that should attach (and show as image / player / chip) ----------

write(
  `${ATTACH}/q4-budget.pdf`,
  makePdf([
    { text: 'Q4 Budget - draft', size: 26, y: 700 },
    { text: 'Prepared for the Ajaia Docs demo.', size: 12, y: 672 },
    { text: 'Engineering ........ $120,000', size: 14, y: 620 },
    { text: 'Design ............. $45,000', size: 14, y: 598 },
    { text: 'Marketing .......... $60,000', size: 14, y: 576 },
    { text: 'Total .............. $225,000', size: 14, y: 548 },
  ]),
);

const budgetRows: [string, number][] = [
  ['Engineering', 120000],
  ['Design', 45000],
  ['Marketing', 60000],
];
write(`${ATTACH}/budget.csv`, ['Team,Budget (USD)', ...budgetRows.map(([t, b]) => `${t},${b}`), `Total,${225000}`, ''].join('\n'));
write(
  `${ATTACH}/budget.xlsx`,
  await makeXlsx('Q4 Budget', [['Team', 'Budget (USD)'], ...budgetRows, ['Total', { formula: 'SUM(B2:B4)' }]]),
);

write(
  `${ATTACH}/launch-jingle.wav`,
  makeWav([
    [523.25, 0.3], // C5
    [659.25, 0.3], // E5
    [783.99, 0.3], // G5
    [1046.5, 0.6], // C6
    [0, 0.25],
    [783.99, 0.25],
    [1046.5, 0.9],
  ]),
);

write(`${ATTACH}/project-brief.docx`, brief);
write(
  `${ATTACH}/release-notes.md`,
  '# Release notes\n\n- Files can now live inside the document text.\n- Audio plays inline; other files are chips.\n',
);
write(`${ATTACH}/meeting-transcript.txt`, 'Alice: Shall we ship the beta?\nBob: Yes, after one more review.\n');

const bundle = new JSZip();
bundle.file('README.txt', 'Brand assets for the Ajaia Docs demo.\n');
bundle.file('brand-colors.csv', 'name,hex\nprimary,#1a56db\nsuccess,#15803d\n');
if (chart) bundle.file('charts/q4-signups-chart.png', chart);
write(`${ATTACH}/design-assets.zip`, await bundle.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

// ---- should-fail/: each one is refused, for a different reason -------------------

write(`${FAIL}/setup.exe`, fakeProgram()); // type not allowed
write(`${FAIL}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(\'xss\')"><circle cx="5" cy="5" r="4"/></svg>\n');
write(`${FAIL}/page.html`, "<!doctype html><html><body><script>alert('xss')</script></body></html>\n");
write(`${FAIL}/notes-without-extension`, 'A file with no extension.\n');
write(`${FAIL}/invoice.pdf`, fakeProgram()); // a program renamed to .pdf
write(`${FAIL}/photo.png`, "<html><script>alert('xss')</script></html>\n"); // a web page renamed to .png
write(`${FAIL}/song.mp3`, 'This is text, not audio.\n'); // text renamed to .mp3
write(`${FAIL}/corrupt.docx`, 'This is not really a Word file.\n'); // not a zip
write(`${FAIL}/binary-notes.txt`, Buffer.from('hello\u0000world\u0000\u0001\u0002', 'binary')); // binary posing as text
write(`${FAIL}/empty.txt`, '');

// Large files are generated but git-ignored (see .gitignore), to keep the repo small.
const pdfHeader = makePdf([{ text: 'Padded to exceed the 10 MB limit', size: 14, y: 700 }]);
write(`${FAIL}/too-big-attachment.pdf`, Buffer.concat([pdfHeader, Buffer.alloc(Math.round(10.5 * 1024 * 1024), 0x20)]));
write(`${FAIL}/too-big-import.txt`, 'This file is over the 5 MB import limit.\n'.repeat(Math.ceil((6 * 1024 * 1024) / 42)));

console.log(`Wrote ${written.length} files:\n${written.map((p) => `  ${p}`).join('\n')}`);
