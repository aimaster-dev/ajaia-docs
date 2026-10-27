import type { Store } from './db.js';
import { hashPassword } from './password.js';
import type { AuthConfig } from '../shared/types.js';

/**
 * Shared demo accounts so reviewers can try sharing without creating several
 * accounts. They all use DEMO_PASSWORD, which the sign-in page shows. Turn them
 * off with DEMO_ACCOUNTS=false.
 */
export const DEMO_PASSWORD = 'ajaia-demo';

export const SEED_USERS = [
  { id: 'user_alice', username: 'alice', name: 'Alice Chen', color: '#2563eb' },
  { id: 'user_bob', username: 'bob', name: 'Bob Okafor', color: '#16a34a' },
  { id: 'user_carol', username: 'carol', name: 'Carol Diaz', color: '#c2410c' },
] as const;

export const DEMO_USER_IDS: ReadonlySet<string> = new Set(SEED_USERS.map((u) => u.id));

export function demoConfig(enabled: boolean): AuthConfig['demo'] {
  return enabled ? { usernames: SEED_USERS.map((u) => u.username), password: DEMO_PASSWORD } : null;
}

const WELCOME_HTML = `
<h1>Q4 Launch Plan</h1>
<p>This document is <strong>owned by Alice</strong> and shared with <em>Bob (can edit)</em> and <u>Carol (can view)</u>. Sign in as each of them to see how access differs.</p>
<h2>Goals</h2>
<ol>
  <li>Ship the editor beta to two internal teams</li>
  <li>Collect feedback on sharing and file import</li>
</ol>
<h2>Open questions</h2>
<ul>
  <li>Do we need comments before the beta?</li>
  <li>Which file types matter most for import?</li>
</ul>
<blockquote><p>Tip: changes save automatically a moment after you stop typing.</p></blockquote>
`.trim();

const BOB_HTML = `
<h2>Interview notes</h2>
<p>Bob's private draft. Nobody else can see this until Bob shares it.</p>
<ul><li>Teams want a fast way to turn a .docx into something editable</li></ul>
`.trim();

let demoHash: Promise<string> | undefined;

/**
 * Makes sure the demo accounts exist and can sign in:
 * - creates any that are missing (sample documents only on a brand-new database),
 * - gives a password to demo users carried over from before passwords existed.
 * Accounts that already have a password are never touched.
 */
export async function seedDemoAccounts(store: Store) {
  const fresh = store.countUsers() === 0;
  demoHash ??= hashPassword(DEMO_PASSWORD); // one hash shared by all demo accounts
  const passwordHash = await demoHash;

  store.transaction(() => {
    for (const u of SEED_USERS) {
      const existing = store.getUserByUsername(u.username);
      if (!existing) store.createUser({ ...u, passwordHash });
      else if (existing.id === u.id && !store.getPasswordHash(existing.id)) store.setPasswordHash(existing.id, passwordHash);
    }
    if (fresh) {
      const [alice, bob, carol] = SEED_USERS;
      const plan = store.createDocument(alice.id, 'Q4 Launch Plan', WELCOME_HTML);
      store.upsertShare(plan.id, bob.id, 'editor');
      store.upsertShare(plan.id, carol.id, 'viewer');
      store.createDocument(bob.id, 'Customer interview notes', BOB_HTML);
    }
  });
}
