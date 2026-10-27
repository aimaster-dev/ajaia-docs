import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response as SuperagentResponse } from 'superagent';
import type { Express } from 'express';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';
import { MAX_ATTACHMENTS_PER_DOCUMENT, MAX_ATTACHMENT_BYTES } from '../src/shared/attachments.js';
import { MAX_IMPORT_BYTES, type Attachment, type DocumentDetail, type DocumentListResponse } from '../src/shared/types.js';
import { makeDocx } from './helpers/docx.js';

// Small but genuine files of each family.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

/** Collects a binary response body into a Buffer (superagent only buffers text by default). */
const binary = (res: SuperagentResponse, done: (err: Error | null, body: unknown) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

let app: Express;
let store: Store;
let doc: DocumentDetail;
let alice: request.Agent;
let bob: request.Agent;
let carol: request.Agent;

async function signIn(username: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORD }).expect(200);
  return agent;
}

const base = () => `/api/documents/${doc.id}/attachments`;
const attach = (agent: request.Agent, data: Buffer, filename: string) =>
  agent.post(base()).attach('file', data, filename);

beforeEach(async () => {
  store = await Store.open({ url: ':memory:' });
  await seedDemoAccounts(store);
  app = createApp(store);
  [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(signIn)) as [request.Agent, request.Agent, request.Agent];
  // Alice owns it; Bob can edit; Carol can view.
  doc = (await alice.post('/api/documents').send({ title: 'Budget' }).expect(201)).body;
  await alice.put(`/api/documents/${doc.id}/shares`).send({ username: 'bob', role: 'editor' }).expect(200);
  await alice.put(`/api/documents/${doc.id}/shares`).send({ username: 'carol', role: 'viewer' }).expect(200);
});

describe('attachments', () => {
  it('uploads, lists and downloads a file byte-for-byte with safe headers', async () => {
    const created = await attach(alice, PDF, 'Q4 forecast.pdf').expect(201);
    const a = created.body.attachment as Attachment;
    expect(a).toMatchObject({ filename: 'Q4 forecast.pdf', mimeType: 'application/pdf', kind: 'pdf', size: PDF.length });
    expect(a.uploadedBy?.username).toBe('alice');
    expect(a).not.toHaveProperty('sha256'); // internal only

    const list = (await alice.get(base()).expect(200)).body.attachments as Attachment[];
    expect(list.map((x) => x.id)).toEqual([a.id]);

    const res = await carol.get(`${base()}/${a.id}`).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Q4 forecast.pdf"; filename*=UTF-8''Q4%20forecast.pdf`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toBe('private, no-cache');

    // Unchanged file: the browser can revalidate without downloading again.
    await carol.get(`${base()}/${a.id}`).set('If-None-Match', res.headers.etag!).expect(304);
  });

  it('keeps non-English names and strips directory parts from filenames', async () => {
    const unicode = (await attach(alice, PDF, 'résumé 2026.pdf').expect(201)).body.attachment as Attachment;
    expect(unicode.filename).toBe('résumé 2026.pdf');
    const res = await alice.get(`${base()}/${unicode.id}`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9%202026.pdf`);

    const sneaky = (await attach(alice, Buffer.from('hello'), '../../etc/passwd.txt').expect(201)).body.attachment;
    expect(sneaky.filename).toBe('passwd.txt');
  });

  it('follows the document’s sharing: owners and editors change, viewers only read, others see nothing', async () => {
    const a = (await attach(bob, PNG, 'chart.png').expect(201)).body.attachment as Attachment; // editor can add
    expect(a.uploadedBy?.username).toBe('bob');

    await carol.get(base()).expect(200); // viewer can list…
    await carol.get(`${base()}/${a.id}`).expect(200); // …and download
    await attach(carol, PDF, 'nope.pdf').expect(403); // but not add
    await carol.delete(`${base()}/${a.id}`).expect(403); // or remove

    const dana = request.agent(app);
    await dana.post('/api/auth/register').send({ name: 'Dana', username: 'dana', password: 'dana-password-1' }).expect(201);
    await dana.get(base()).expect(404); // no access: not even its existence
    await dana.get(`${base()}/${a.id}`).expect(404);
    await attach(dana, PDF, 'x.pdf').expect(404);
    await request(app).get(`${base()}/${a.id}`).expect(401);

    // An attachment id only works under its own document.
    const other = (await alice.post('/api/documents').send({ title: 'Other' }).expect(201)).body as DocumentDetail;
    await alice.get(`/api/documents/${other.id}/attachments/${a.id}`).expect(404);

    await bob.delete(`${base()}/${a.id}`).expect(204); // editor can remove
    await alice.get(`${base()}/${a.id}`).expect(404);
  });

  // Streams multi-megabyte uploads, so it gets more time than the 5 s default on a busy machine.
  it('rejects unsupported, disguised, empty and oversized files with clear reasons', { timeout: 20_000 }, async () => {
    const exe = await attach(alice, EXE, 'setup.exe').expect(415);
    expect(exe.body.error.message).toMatch(/“\.exe” files can’t be attached\. Allowed: PDF, Word/);
    await attach(alice, Buffer.from('<svg onload="alert(1)"/>'), 'logo.svg').expect(415);

    const disguised = await attach(alice, EXE, 'invoice.pdf').expect(422); // a program renamed to .pdf
    expect(disguised.body.error.code).toBe('content_mismatch');
    await attach(alice, Buffer.from('<html><script>alert(1)</script></html>'), 'photo.png').expect(422);
    await attach(alice, Buffer.from([0x68, 0x00, 0x69]), 'notes.txt').expect(422); // binary posing as text

    await attach(alice, Buffer.alloc(0), 'empty.pdf').expect(400);
    const big = await attach(alice, Buffer.concat([PDF, Buffer.alloc(MAX_ATTACHMENT_BYTES)]), 'huge.pdf').expect(413);
    expect(big.body.error.message).toBe('That file is larger than the 4 MB limit.');
    await alice.post(base()).expect(400); // no file at all

    expect((await alice.get(base()).expect(200)).body.attachments).toEqual([]);
  });

  it('accepts real Office files and shows only images inline', async () => {
    const docx = await makeDocx([{ runs: ['Hello'] }]);
    await attach(alice, docx, 'Brief.docx').expect(201);

    const img = (await attach(alice, PNG, 'chart.png').expect(201)).body.attachment as Attachment;
    const pdf = (await attach(alice, PDF, 'report.pdf').expect(201)).body.attachment as Attachment;
    const imgRes = await alice.get(`${base()}/${img.id}?inline=1`).buffer(true).parse(binary).expect(200);
    expect(imgRes.headers['content-disposition']).toMatch(/^inline;/);
    expect(imgRes.headers['content-type']).toBe('image/png');
    const pdfRes = await alice.get(`${base()}/${pdf.id}?inline=1`).buffer(true).parse(binary).expect(200);
    expect(pdfRes.headers['content-disposition']).toMatch(/^attachment;/); // never rendered in the app
  });

  it(`limits a document to ${MAX_ATTACHMENTS_PER_DOCUMENT} attachments`, async () => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_DOCUMENT; i++) await attach(alice, PDF, `file-${i}.pdf`).expect(201);
    const res = await attach(alice, PDF, 'one-too-many.pdf').expect(409);
    expect(res.body.error.code).toBe('too_many_attachments');
  });

  it('keeps the limit when several uploads arrive at once', async () => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_DOCUMENT - 1; i++) await attach(alice, PDF, `file-${i}.pdf`).expect(201);
    // One slot left, three uploads racing for it: exactly one wins.
    const results = await Promise.all([alice, bob, alice].map((agent, i) => attach(agent, PDF, `race-${i}.pdf`)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await store.countAttachments(doc.id)).toBe(MAX_ATTACHMENTS_PER_DOCUMENT);
  });

  it('shows attachment counts in document lists and deletes files along with their document', async () => {
    await attach(alice, PDF, 'a.pdf').expect(201);
    await attach(bob, PNG, 'b.png').expect(201);

    const carolsList = (await carol.get('/api/documents').expect(200)).body as DocumentListResponse;
    expect(carolsList.shared[0]).toMatchObject({ title: 'Budget', attachmentCount: 2 });
    expect((await alice.get(`/api/documents/${doc.id}`).expect(200)).body.attachmentCount).toBe(2);

    await alice.delete(`/api/documents/${doc.id}`).expect(204);
    const left = async (t: string) => Number((await store.client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
    expect(await left('attachments')).toBe(0);
    expect(await left('attachment_blobs')).toBe(0); // no orphaned file contents
  });

  it('keeps the import size limit message accurate (its own limit)', { timeout: 20_000 }, async () => {
    const res = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.alloc(MAX_IMPORT_BYTES + 1, 'a'), 'huge.txt')
      .expect(413);
    expect(res.body.error.message).toBe('That file is larger than the 4 MB limit.');
  });
});
