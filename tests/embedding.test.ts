import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response as SuperagentResponse } from 'superagent';
import type { Express } from 'express';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';
import { attachmentPath } from '../src/shared/attachments.js';
import type { Attachment, DocumentDetail } from '../src/shared/types.js';
import { makeDocx } from './helpers/docx.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
// An MP3 with an ID3 header followed by recognizable bytes, so ranges are easy to check.
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from(Array.from({ length: 997 }, (_, i) => i % 256))]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(100)]);

const binary = (res: SuperagentResponse, done: (err: Error | null, body: unknown) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

let app: Express;
let alice: request.Agent;
let doc: DocumentDetail;

async function signIn(username: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORD }).expect(200);
  return agent;
}

async function upload(d: DocumentDetail, data: Buffer, filename: string): Promise<Attachment> {
  return (await alice.post(`/api/documents/${d.id}/attachments`).attach('file', data, filename).expect(201)).body.attachment;
}

const save = (html: string, baseVersion = doc.version) =>
  alice.patch(`/api/documents/${doc.id}`).send({ contentHtml: html, baseVersion }).expect(200);

/** The HTML the editor produces for each kind of embed. */
const embed = {
  image: (a: Attachment) => `<img src="${attachmentPath(a.documentId, a.id, true)}" alt="${a.filename}" data-attachment-id="${a.id}">`,
  audio: (a: Attachment) =>
    `<audio src="${attachmentPath(a.documentId, a.id, true)}" controls="true" data-attachment-id="${a.id}" data-file-name="${a.filename}"></audio>`,
  chip: (a: Attachment) =>
    `<a href="${attachmentPath(a.documentId, a.id)}" data-attachment-id="${a.id}" data-file-name="${a.filename}" data-file-size="${a.size}" data-file-kind="${a.kind}">${a.filename}</a>`,
};

beforeEach(async () => {
  const store = new Store(':memory:');
  await seedDemoAccounts(store);
  app = createApp(store);
  alice = await signIn('alice');
  doc = (await alice.post('/api/documents').send({ title: 'Launch' }).expect(201)).body;
});

describe('files embedded in the document text', () => {
  it('keeps images, audio players and file chips that point at this document’s attachments', async () => {
    const img = await upload(doc, PNG, 'chart.png');
    const song = await upload(doc, MP3, 'jingle.mp3');
    const pdf = await upload(doc, PDF, 'brief.pdf');

    const html = `<p>Intro</p>${embed.image(img)}<p>Listen:</p>${embed.audio(song)}<p>See ${embed.chip(pdf)} for details.</p>`;
    const saved = (await save(html)).body as DocumentDetail;
    const reopened = (await alice.get(`/api/documents/${doc.id}`).expect(200)).body as DocumentDetail;
    expect(reopened.contentHtml).toBe(saved.contentHtml);

    const out = reopened.contentHtml;
    expect(out).toContain(`<img src="${attachmentPath(doc.id, img.id, true)}" alt="chart.png" data-attachment-id="${img.id}" />`);
    expect(out).toContain(`<audio src="${attachmentPath(doc.id, song.id, true)}" controls="true" data-attachment-id="${song.id}"`);
    expect(out).toMatch(new RegExp(`<a href="${attachmentPath(doc.id, pdf.id)}" data-attachment-id="${pdf.id}"[^>]*data-file-kind="pdf"[^>]*>brief\\.pdf</a>`));
  });

  it('strips embeds that point anywhere else, keeping the surrounding text', async () => {
    const other = (await alice.post('/api/documents').send({ title: 'Other' }).expect(201)).body as DocumentDetail;
    const foreign = await upload(other, PNG, 'theirs.png');
    const mine = await upload(doc, PNG, 'mine.png');
    const fakeId = '11111111-2222-3333-4444-555555555555';

    const hostile = [
      '<p>keep me</p>',
      '<img src="https://evil.example/pixel.gif">', // tracking pixel
      `<img src="data:image/png;base64,${PNG.toString('base64')}">`, // inline data
      embed.image(foreign), // another document's file
      `<img src="${attachmentPath(doc.id, mine.id, true)}" data-attachment-id="${fakeId}">`, // id mismatch
      `<img src="${attachmentPath(doc.id, mine.id, true)}">`, // no id
      '<audio src="https://evil.example/a.mp3" controls data-attachment-id="x"></audio>',
      `<p><a href="javascript:alert(1)" data-attachment-id="${mine.id}" data-file-size="1" data-file-kind="pdf">bad chip</a></p>`,
      `<p><a href="${attachmentPath(doc.id, mine.id)}" data-attachment-id="${mine.id}" data-file-size="lots" data-file-kind="pdf">bad size</a></p>`,
      `<p><a href="${attachmentPath(doc.id, mine.id)}" data-attachment-id="${mine.id}" data-file-size="9" data-file-kind="exe">bad kind</a></p>`,
      '<p><a href="https://example.com">normal link</a></p>',
    ].join('');

    const out = ((await save(hostile)).body as DocumentDetail).contentHtml;
    expect(out).not.toMatch(/<img|<audio|evil\.example|data:image|javascript:|bad chip|bad size|bad kind/);
    expect(out).toContain('<p>keep me</p>');
    expect(out).toContain('href="https://example.com"'); // ordinary links are unaffected
  });

  it('never embeds anything in a document created from raw HTML (it has no attachments yet)', async () => {
    const existing = await upload(doc, PNG, 'p.png');
    const created = await alice
      .post('/api/documents')
      .send({ title: 'x', contentHtml: `<p>a</p>${embed.image(existing)}` })
      .expect(201);
    expect(created.body.contentHtml).toBe('<p>a</p>');
  });
});

describe('partial downloads (for media seeking)', () => {
  it('serves byte ranges with 206 and rejects ranges outside the file', async () => {
    const song = await upload(doc, MP3, 'jingle.mp3');
    const url = attachmentPath(doc.id, song.id, true);

    const full = await alice.get(url).buffer(true).parse(binary).expect(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-disposition']).toMatch(/^inline;/); // audio plays in the page

    const first = await alice.get(url).set('Range', 'bytes=0-9').buffer(true).parse(binary).expect(206);
    expect(first.headers['content-range']).toBe(`bytes 0-9/${MP3.length}`);
    expect(Buffer.compare(first.body as Buffer, MP3.subarray(0, 10))).toBe(0);

    const tail = await alice.get(url).set('Range', 'bytes=-5').buffer(true).parse(binary).expect(206);
    expect(Buffer.compare(tail.body as Buffer, MP3.subarray(-5))).toBe(0);

    const open = await alice.get(url).set('Range', 'bytes=990-').buffer(true).parse(binary).expect(206);
    expect((open.body as Buffer).length).toBe(MP3.length - 990);

    const bad = await alice.get(url).set('Range', `bytes=${MP3.length}-`).expect(416);
    expect(bad.headers['content-range']).toBe(`bytes */${MP3.length}`);
  });

  it('accepts real audio and video, plays only audio inline, and rejects fakes', async () => {
    const clip = await upload(doc, MP4, 'demo.mp4');
    expect(clip.kind).toBe('video');
    const res = await alice.get(attachmentPath(doc.id, clip.id, true)).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/); // video is a download chip for now
    await alice.post(`/api/documents/${doc.id}/attachments`).attach('file', Buffer.from('not really audio'), 'fake.mp3').expect(422);
  });
});

describe('importing a .docx with pictures', () => {
  it('turns each picture into an attachment embedded where it was', async () => {
    const docx = await makeDocx([
      { style: 'Heading1', runs: ['Report'] },
      { runs: ['Before the chart.'] },
      { runs: [{ image: PNG, alt: 'Revenue chart' }] },
      { runs: [{ image: Buffer.from('not an image we keep'), extension: 'emf' }] },
      { runs: ['After the chart.'] },
    ]);
    const imported = (await alice.post('/api/documents/import').attach('file', docx, 'Report.docx').expect(201))
      .body as DocumentDetail;

    const files = (await alice.get(`/api/documents/${imported.id}/attachments`).expect(200)).body.attachments as Attachment[];
    expect(files.map((f) => [f.filename, f.kind, f.size])).toEqual([['image-1.png', 'image', PNG.length]]);
    expect(imported.attachmentCount).toBe(1);
    expect(imported.version).toBe(1);

    const html = imported.contentHtml;
    expect(html).toContain(`<img src="${attachmentPath(imported.id, files[0]!.id, true)}" data-attachment-id="${files[0]!.id}" alt="Revenue chart" />`);
    // Order is preserved: text, picture, text. The unsupported EMF picture is dropped.
    expect(html.indexOf('Before the chart.')).toBeLessThan(html.indexOf('<img'));
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('After the chart.'));
    expect(html.match(/<img/g)).toHaveLength(1);
    // A picture alone in its Word paragraph doesn't leave empty paragraphs behind.
    expect(html).not.toContain('<p></p>');
    expect(html).not.toMatch(/<p>\s*<img/);

    const bytes = await alice.get(attachmentPath(imported.id, files[0]!.id)).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(bytes.body as Buffer, PNG)).toBe(0);
  });
});
