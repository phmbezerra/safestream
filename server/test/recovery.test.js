import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/core.js';
import { createApp } from '../src/app.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safestream-t08c-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}
function setup(file) {
  const db = createStore({ stateFile: file });
  const alice = db.session('Alice');
  const bob = db.session('Bob');
  const carol = db.session('Carol');
  const rm = db.room(alice.user);
  const invBob = db.invite(rm, alice.user);
  db.join(rm, bob.user, invBob);
  const invCarol = db.invite(rm, alice.user);
  db.join(rm, carol.user, invCarol);
  return { db, alice, bob, carol, rm };
}

test('T-08C: allowed sessions and room membership survive Node store restart', t => {
  const file = fixture(t);
  const { alice, bob, rm } = setup(file);
  const restored = createStore({ stateFile: file });
  assert.deepEqual(restored.identity(alice.secret), alice.user);
  assert.deepEqual(restored.identity(bob.secret), bob.user);
  assert.equal(restored.get(rm.id).members.get(bob.user.id).role, 'viewer');
  assert.equal(restored.get(rm.id).members.get(alice.user.id).role, 'publisher');
  assert.equal(restored.get(rm.id).peers.size, 0);
  assert.equal(restored.get(rm.id).invites.size, 0);
});

test('T-08C: revoked membership is never restored by restart', t => {
  const file = fixture(t);
  const { db, alice, bob, carol, rm } = setup(file);
  db.revoke(rm, alice.user, bob.user.id);
  const restored = createStore({ stateFile: file });
  assert.equal(restored.identity(bob.secret).id, bob.user.id); // identity still exists
  assert.throws(() => restored.requireMember(restored.get(rm.id), bob.user), /Not a room member/);
  assert.equal(restored.requireMember(restored.get(rm.id), carol.user).role, 'viewer');
  assert.equal(restored.requireMember(restored.get(rm.id), alice.user).role, 'publisher');
});

test('T-08C: bearer secrets and one-use invites are not stored at rest', t => {
  const file = fixture(t);
  const db = createStore({stateFile: file});
  const a = db.session('Alice');
  const b = db.session('Bob');
  const rm = db.room(a.user);
  const unused = db.invite(rm, a.user);
  const data = fs.readFileSync(file, 'utf8');
  assert.equal(data.includes(a.secret), false);
  assert.equal(data.includes(b.secret), false);
  assert.equal(data.includes(unused), false);
  assert.equal(data.includes('fingerprint'), true);
  const restored = createStore({stateFile: file});
  assert.throws(() => restored.join(restored.get(rm.id), b.user, unused), /Invalid or expired invite/);
});

test('T-08C: invalid persisted state refuses startup instead of resetting permissions', t => {
  const file = fixture(t);
  fs.writeFileSync(file, '{corrupted-json', 'utf8');
  assert.throws(() => createStore({stateFile:file}), /refusing to start/);
  fs.writeFileSync(file, JSON.stringify({schemaVersion:'t08c-state-1',sessions:[],rooms:[{id:'abcdefghijkl',ownerId:'a'.repeat(32),members:[]}]}));
  assert.throws(() => createStore({stateFile:file}), /refusing to start/);
});

test('T-08C: failed disk commit does not emit revocation or alter in-memory grants', t => {
  const file = fixture(t);
  const { db, alice, bob, rm } = setup(file);
  // Force an I/O failure without mutating the persisted snapshot; directory is absent.
  // createStore keeps a path, so make the existing state file a directory to cause EISDIR on rename.
  // This is cross-platform: a directory cannot be replaced by a regular file.
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  const fakePeer = {readyState:1, messages:[], send(x){this.messages.push(x);}, close(){this.closed = true;}};
  rm.peers.set(bob.user.id, fakePeer);
  assert.throws(() => db.revoke(rm, alice.user, bob.user.id));
  assert.equal(db.requireMember(rm, bob.user).role, 'viewer');
  assert.deepEqual(fakePeer.messages, []);
  assert.equal(fakePeer.closed, undefined);
});

test('T-08C: HTTP membership API restores grants but never revoked access', async t => {
  const file = fixture(t);
  const { alice, bob, carol, rm, db } = setup(file);
  db.revoke(rm, alice.user, bob.user.id);
  const app = createApp({stateFile:file});
  app.server.listen(0, '127.0.0.1');
  await new Promise(resolve => app.server.once('listening', resolve));
  t.after(async () => {
    for (const w of app.wss.clients) w.terminate();
    for (const w of app.mediaWss.clients) w.terminate();
    await new Promise(r => app.mediaWss.close(r));
    await new Promise(r => app.wss.close(r));
    await new Promise(r => app.server.close(r));
  });
  async function membership(secret) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/rooms/${rm.id}`, {
      headers: {Authorization: `Bearer ${secret}`}
    });
    return response.status;
  }
  assert.equal(await membership(alice.secret), 200);
  assert.equal(await membership(carol.secret), 200);
  assert.equal(await membership(bob.secret), 403);
});
