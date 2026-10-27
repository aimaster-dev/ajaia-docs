import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';
import { MAX_IMPORT_BYTES, type DocumentDetail, type DocumentListResponse } from '../src/shared/types.js';
import { makeDocx } from './helpers/docx.js';

const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';

let app: Express;

beforeEach(async () => {
  // A fresh in-memory database per test keeps tests independent.
  const store = await Store.open({ url: ':memory:' });
  await seedDemoAccounts(store);
  app = createApp(store);
});

async function signIn(username: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORD }).expect(200);
  return agent;
}

async function createDoc(agent: request.Agent, title = 'Draft'): Promise<DocumentDetail> {
  const res = await agent.post('/api/documents').send({ title }).expect(201);
  return res.body;
}

describe('access', () => {
  it('rejects document access without a session', async () => {
    const res = await request(app).get('/api/documents').expect(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
});

describe('documents', () => {
  it('creates, renames, saves and reopens a document with formatting intact', async () => {
    const alice = await signIn(ALICE);
    const doc = await createDoc(alice, 'Kickoff');
    expect(doc).toMatchObject({ title: 'Kickoff', role: 'owner', version: 1 });

    await alice.patch(`/api/documents/${doc.id}`).send({ title: '  Kickoff notes  ' }).expect(200);

    const html = '<h2>Agenda</h2><p><strong>Bold</strong>, <em>italic</em> and <u>underline</u></p><ol><li><p>One</p></li></ol>';
    const saved = await alice
      .patch(`/api/documents/${doc.id}`)
      .send({ contentHtml: html, baseVersion: doc.version })
      .expect(200);
    expect(saved.body.version).toBe(2);

    // "Reopen": a fresh request returns exactly what was saved.
    const reopened = await alice.get(`/api/documents/${doc.id}`).expect(200);
    expect(reopened.body.title).toBe('Kickoff notes');
    expect(reopened.body.contentHtml).toBe(html);
  });

  it('strips scripts, event handlers and unsafe links before storing content', async () => {
    const alice = await signIn(ALICE);
    const doc = await createDoc(alice);
    const res = await alice
      .patch(`/api/documents/${doc.id}`)
      .send({
        contentHtml:
          '<p onclick="steal()">Hi<script>alert(1)</script></p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>',
        baseVersion: 1,
      })
      .expect(200);
    expect(res.body.contentHtml).not.toMatch(/script|onclick|onerror|<img|javascript:/i);
    expect(res.body.contentHtml).toContain('<p>Hi</p>');
  });

  it('rejects a save based on a stale version instead of overwriting', async () => {
    const alice = await signIn(ALICE);
    const doc = await createDoc(alice);
    await alice.patch(`/api/documents/${doc.id}`).send({ contentHtml: '<p>first</p>', baseVersion: 1 }).expect(200);

    const stale = await alice
      .patch(`/api/documents/${doc.id}`)
      .send({ contentHtml: '<p>second</p>', baseVersion: 1 })
      .expect(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.current.contentHtml).toBe('<p>first</p>');
  });

  it('validates input', async () => {
    const alice = await signIn(ALICE);
    const doc = await createDoc(alice);
    await alice.patch(`/api/documents/${doc.id}`).send({ title: 'x'.repeat(201) }).expect(400);
    await alice.patch(`/api/documents/${doc.id}`).send({ contentHtml: '<p>no version</p>' }).expect(400);
    await alice.patch(`/api/documents/${doc.id}`).send({}).expect(400);
    const blank = await alice.patch(`/api/documents/${doc.id}`).send({ title: '   ' }).expect(200);
    expect(blank.body.title).toBe('Untitled document');
  });
});

describe('sharing', () => {
  it('keeps documents private until shared, then enforces the granted role', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const doc = await createDoc(alice, 'Budget');

    // Private: Bob can't see it at all (404, not 403, so existence isn't leaked).
    await bob.get(`/api/documents/${doc.id}`).expect(404);

    // Share as viewer.
    await alice.put(`/api/documents/${doc.id}/shares`).send({ username: BOB, role: 'viewer' }).expect(200);
    const list = (await bob.get('/api/documents').expect(200)).body as DocumentListResponse;
    expect(list.shared.map((d) => d.title)).toContain('Budget');
    expect(list.owned.map((d) => d.title)).not.toContain('Budget');
    expect((await bob.get(`/api/documents/${doc.id}`).expect(200)).body.role).toBe('viewer');

    // Viewers can't edit, rename, reshare or delete.
    await bob.patch(`/api/documents/${doc.id}`).send({ contentHtml: '<p>hi</p>', baseVersion: 1 }).expect(403);
    await bob.patch(`/api/documents/${doc.id}`).send({ title: 'Mine now' }).expect(403);
    await bob.put(`/api/documents/${doc.id}/shares`).send({ username: CAROL, role: 'editor' }).expect(403);
    await bob.delete(`/api/documents/${doc.id}`).expect(403);

    // Upgrade to editor: Bob's edit lands and is attributed to him.
    await alice.put(`/api/documents/${doc.id}/shares`).send({ username: BOB, role: 'editor' }).expect(200);
    await bob.patch(`/api/documents/${doc.id}`).send({ contentHtml: '<p>Bob was here</p>', baseVersion: 1 }).expect(200);
    const seenByAlice = (await alice.get(`/api/documents/${doc.id}`).expect(200)).body as DocumentDetail;
    expect(seenByAlice.contentHtml).toBe('<p>Bob was here</p>');
    expect(seenByAlice.updatedBy?.username).toBe(BOB);

    // Editors still can't manage access or delete.
    await bob.put(`/api/documents/${doc.id}/shares`).send({ username: CAROL, role: 'viewer' }).expect(403);
    await bob.delete(`/api/documents/${doc.id}`).expect(403);

    // Revoke: back to invisible.
    const bobUser = (await bob.get('/api/auth/me')).body.user;
    await alice.delete(`/api/documents/${doc.id}/shares/${bobUser.id}`).expect(204);
    await bob.get(`/api/documents/${doc.id}`).expect(404);
  });

  it('rejects shares with unknown users or the owner', async () => {
    const alice = await signIn(ALICE);
    const doc = await createDoc(alice);
    const unknown = await alice
      .put(`/api/documents/${doc.id}/shares`)
      .send({ username: 'nobody', role: 'viewer' })
      .expect(404);
    expect(unknown.body.error.code).toBe('user_not_found');
    await alice.put(`/api/documents/${doc.id}/shares`).send({ username: ALICE, role: 'editor' }).expect(400);
    await alice.put(`/api/documents/${doc.id}/shares`).send({ username: BOB, role: 'admin' }).expect(400);
  });

  it('shows the seeded demo document as owned by Alice and shared with Bob and Carol', async () => {
    const alice = (await (await signIn(ALICE)).get('/api/documents')).body as DocumentListResponse;
    const carol = (await (await signIn(CAROL)).get('/api/documents')).body as DocumentListResponse;
    expect(alice.owned[0]).toMatchObject({ title: 'Q4 Launch Plan', role: 'owner', sharedWithCount: 2 });
    expect(carol.owned).toHaveLength(0);
    expect(carol.shared[0]).toMatchObject({ title: 'Q4 Launch Plan', role: 'viewer' });
  });
});

describe('file import', () => {
  it('turns a Markdown file into a formatted document', async () => {
    const alice = await signIn(ALICE);
    const md = '# Roadmap\n\nSome **bold** text.\n\n- one\n- two\n\n1. first\n';
    const res = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from(md), 'team_roadmap.md')
      .expect(201);
    expect(res.body.title).toBe('team roadmap');
    expect(res.body.contentHtml).toContain('<h1>Roadmap</h1>');
    expect(res.body.contentHtml).toContain('<strong>bold</strong>');
    expect(res.body.contentHtml).toMatch(/<ul>\s*<li>one<\/li>/);
    expect(res.body.contentHtml).toContain('<ol>');
  });

  it('imports plain text as escaped paragraphs', async () => {
    const alice = await signIn(ALICE);
    const res = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from('Line one\nline two\n\n<b>not html</b>'), 'notes.txt')
      .expect(201);
    expect(res.body.contentHtml).toBe('<p>Line one<br />line two</p><p>&lt;b&gt;not html&lt;/b&gt;</p>');
  });

  it('converts a .docx file, keeping headings and inline formatting', async () => {
    const alice = await signIn(ALICE);
    const docx = await makeDocx([
      { style: 'Heading1', runs: ['Project brief'] },
      { runs: [{ text: 'Bold', bold: true }, ' and ', { text: 'underlined', underline: true }] },
    ]);
    const res = await alice.post('/api/documents/import').attach('file', docx, 'brief.docx').expect(201);
    expect(res.body.title).toBe('brief');
    expect(res.body.contentHtml).toContain('<h1>Project brief</h1>');
    expect(res.body.contentHtml).toContain('<strong>Bold</strong>');
    expect(res.body.contentHtml).toContain('<u>underlined</u>');
  });

  // Streams multi-megabyte uploads, so it gets more time than the 5 s default on a busy machine.
  it('rejects unsupported, empty, corrupt and oversized files with clear errors', { timeout: 20_000 }, async () => {
    const alice = await signIn(ALICE);
    const pdf = await alice.post('/api/documents/import').attach('file', Buffer.from('%PDF'), 'x.pdf').expect(415);
    expect(pdf.body.error.message).toMatch(/\.txt, \.md and \.docx/);
    await alice.post('/api/documents/import').attach('file', Buffer.alloc(0), 'empty.txt').expect(400);
    await alice.post('/api/documents/import').attach('file', Buffer.from('not a zip'), 'bad.docx').expect(422);
    await alice
      .post('/api/documents/import')
      .attach('file', Buffer.alloc(MAX_IMPORT_BYTES + 1, 'a'), 'huge.txt')
      .expect(413);
    await alice.post('/api/documents/import').expect(400);
  });
});
