import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/server/app.js';
import { SESSION_COOKIE } from '../src/server/auth.js';
import { Store } from '../src/server/db.js';
import { DEMO_PASSWORD, seedDemoAccounts } from '../src/server/seed.js';
import type { DocumentDetail, DocumentListResponse, User } from '../src/shared/types.js';

let app: Express;
let store: Store;

beforeEach(async () => {
  store = await Store.open({ url: ':memory:' });
  await seedDemoAccounts(store);
  app = createApp(store, { demoAccounts: true });
});

const DANA = { name: 'Dana Park', username: 'dana', password: 'correct horse battery' };

const register = (agent: request.Agent | ReturnType<typeof request>, body: object) =>
  agent.post('/api/auth/register').send(body);

const login = (username: string, password: string) =>
  request(app).post('/api/auth/login').send({ username, password });

async function signedIn(username: string, password = DEMO_PASSWORD) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password }).expect(200);
  return agent;
}

describe('sign-up', () => {
  it('creates an account, signs it in, and stores only a salted hash of the password', async () => {
    const agent = request.agent(app);
    const res = await register(agent, { ...DANA, username: '  @Dana ' }).expect(201);

    expect(res.body.user).toMatchObject({ username: 'dana', name: 'Dana Park' });
    expect(Object.keys(res.body.user).sort()).toEqual(['color', 'id', 'name', 'username']);
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${SESSION_COOKIE}=\\w+;.*HttpOnly.*SameSite=Lax`, 'i'));

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.username).toBe('dana');

    const hash = (await store.getPasswordHash(res.body.user.id))!;
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(hash).not.toContain(DANA.password);

    const docs = (await agent.get('/api/documents').expect(200)).body as DocumentListResponse;
    expect(docs).toEqual({ owned: [], shared: [] });
  });

  it('gives two accounts with the same password different hashes', async () => {
    const a = await register(request(app), { ...DANA, username: 'dana' }).expect(201);
    const b = await register(request(app), { ...DANA, username: 'dana2' }).expect(201);
    expect(await store.getPasswordHash(a.body.user.id)).not.toBe(await store.getPasswordHash(b.body.user.id));
  });

  it('rejects usernames that are taken, ignoring case', async () => {
    await register(request(app), DANA).expect(201);
    const dup = await register(request(app), { ...DANA, username: 'DANA' }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'username_taken', details: { field: 'username' } });
    await register(request(app), { ...DANA, username: 'alice' }).expect(409);
  });

  it.each([
    [{ username: 'ab' }, 'username', /at least 3 characters/],
    [{ username: 'has space' }, 'username', /letters, numbers/i],
    [{ username: '-dana' }, 'username', /start and end/],
    [{ username: 'x'.repeat(33) }, 'username', /32 characters or fewer/],
    [{ password: 'short' }, 'password', /at least 8 characters/],
    [{ password: '         ' }, 'password', /only spaces/],
    [{ username: 'longusername', password: 'LongUsername' }, 'password', /same as your username/],
    [{ name: '   ' }, 'name', /Enter your name/],
  ])('validates input: %o', async (override, field, message) => {
    const res = await register(request(app), { ...DANA, ...override }).expect(400);
    expect(res.body.error.details.field).toBe(field);
    expect(res.body.error.message).toMatch(message);
  });
});

describe('sign-in', () => {
  it('signs in with a username (any case) and password', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ username: 'ALICE', password: DEMO_PASSWORD }).expect(200);
    expect(res.body.user.username).toBe('alice');
    await agent.get('/api/documents').expect(200);
  });

  it('answers a wrong password and an unknown username identically', async () => {
    const wrong = await login('alice', 'not-the-password').expect(401);
    const unknown = await login('mallory', 'not-the-password').expect(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.body.error.message).toBe('Incorrect username or password.');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('blocks an account after 5 failed attempts; a successful sign-in resets the count', async () => {
    for (let i = 0; i < 4; i++) await login('alice', 'guess').expect(401);
    await login('alice', DEMO_PASSWORD).expect(200); // resets
    for (let i = 0; i < 5; i++) await login('alice', 'guess').expect(401);

    const blocked = await login('alice', DEMO_PASSWORD).expect(429); // even the right password
    expect(blocked.body.error.message).toMatch(/Too many attempts/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    await login('bob', DEMO_PASSWORD).expect(200); // other accounts are unaffected
  });

  it('signs out by deleting the session on the server', async () => {
    const res = await login('alice', DEMO_PASSWORD).expect(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    await request(app).get('/api/documents').set('Cookie', cookie).expect(200);

    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    // Replaying the old cookie doesn't work: the session is gone server-side.
    await request(app).get('/api/documents').set('Cookie', cookie).expect(401);
  });

  it('rejects made-up and expired session tokens', async () => {
    await request(app).get('/api/documents').set('Cookie', `${SESSION_COOKIE}=deadbeef`).expect(401);

    const alice = (await store.getUserByUsername('alice'))!;
    const { token } = await store.createSession(alice.id);
    await store.client.execute({ sql: 'UPDATE sessions SET expires_at = ? WHERE token = ?', args: ['2000-01-01T00:00:00.000Z', token] });
    await request(app).get('/api/documents').set('Cookie', `${SESSION_COOKIE}=${token}`).expect(401);
  });
});

describe('change password', () => {
  it('needs the current password, then signs out other devices but keeps this one', async () => {
    const laptop = request.agent(app);
    await register(laptop, DANA).expect(201);
    const phone = await signedIn('dana', DANA.password);

    const wrong = await laptop
      .post('/api/auth/password')
      .send({ currentPassword: 'not-it', newPassword: 'a brand new secret' })
      .expect(400);
    expect(wrong.body.error.details.field).toBe('currentPassword');

    await laptop
      .post('/api/auth/password')
      .send({ currentPassword: DANA.password, newPassword: 'a brand new secret' })
      .expect(204);
    await laptop.get('/api/documents').expect(200); // this device stays signed in
    await phone.get('/api/documents').expect(401); // every other session was revoked

    await login('dana', DANA.password).expect(401);
    await login('dana', 'a brand new secret').expect(200);
  });

  it('validates the new password and protects the shared demo accounts', async () => {
    const laptop = request.agent(app);
    await register(laptop, DANA).expect(201);
    await laptop.post('/api/auth/password').send({ currentPassword: DANA.password, newPassword: 'short' }).expect(400);

    const alice = await signedIn('alice');
    await alice
      .post('/api/auth/password')
      .send({ currentPassword: DEMO_PASSWORD, newPassword: 'hijacked-password' })
      .expect(403);
    await login('alice', DEMO_PASSWORD).expect(200);
  });

  it('requires a session', async () => {
    await request(app).post('/api/auth/password').send({ currentPassword: 'x', newPassword: 'yyyyyyyy' }).expect(401);
  });
});

describe('sharing with registered accounts', () => {
  it('finds people by username or name and shares with them', async () => {
    const dana = request.agent(app);
    await register(dana, DANA).expect(201);
    const alice = await signedIn('alice');

    const byUsername = (await alice.get('/api/users?q=da').expect(200)).body.users as User[];
    expect(byUsername.map((u) => u.username)).toEqual(['dana']);
    expect(Object.keys(byUsername[0]!).sort()).toEqual(['color', 'id', 'name', 'username']);
    const byName = (await alice.get('/api/users?q=park').expect(200)).body.users as User[];
    expect(byName.map((u) => u.username)).toEqual(['dana']);
    expect((await alice.get('/api/users?q=ali').expect(200)).body.users).toEqual([]); // never yourself
    expect((await alice.get('/api/users?q=%25').expect(200)).body.users).toEqual([]); // "%" isn't a wildcard
    await request(app).get('/api/users?q=da').expect(401);

    const doc = (await alice.post('/api/documents').send({ title: 'For Dana' }).expect(201)).body as DocumentDetail;
    await alice.put(`/api/documents/${doc.id}/shares`).send({ username: '@Dana', role: 'viewer' }).expect(200);
    const list = (await dana.get('/api/documents').expect(200)).body as DocumentListResponse;
    expect(list.shared.map((d) => [d.title, d.role, d.owner.username])).toEqual([['For Dana', 'viewer', 'alice']]);
  });
});

describe('sign-in page config', () => {
  it('advertises the demo accounts only when they are enabled', async () => {
    const on = await request(app).get('/api/auth/config').expect(200);
    expect(on.body.demo).toEqual({ usernames: ['alice', 'bob', 'carol'], password: DEMO_PASSWORD });

    const off = await request(createApp(await Store.open({ url: ':memory:' }))).get('/api/auth/config').expect(200);
    expect(off.body.demo).toBeNull();
  });
});
