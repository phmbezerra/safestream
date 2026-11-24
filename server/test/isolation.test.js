// T-09: adversarial cross-room isolation tests for the existing local Node API.
// No real users, recordings, browser permissions or external services involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fixture(t) {
  const app = createApp(); // No persistent file; independent fresh room state.
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();
    await new Promise(resolve => app.mediaWss.close(resolve));
    await new Promise(resolve => app.wss.close(resolve));
    await new Promise(resolve => app.server.close(resolve));
  });
  const port = app.server.address().port;
  const api = async (method, path, bearer, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {'Content-Type': 'application/json', ...(bearer ? {Authorization: 'Bearer ' + bearer} : {})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: res.status, data: await res.json()};
  };
  const create = async label => (await api('POST', '/api/sessions', null, {label})).data;
  const alice = await create('Alice');
  const bob = await create('Bob');
  const diana = await create('Diana');
  const carol = await create('Carol');
  const eve = await create('Eve');
  const roomA = (await api('POST', '/api/rooms', alice.secret)).data.roomId;
  const roomB = (await api('POST', '/api/rooms', diana.secret)).data.roomId;
  const inviteA = (await api('POST', `/api/rooms/${roomA}/invites`, alice.secret)).data.invite;
  const inviteB = (await api('POST', `/api/rooms/${roomB}/invites`, diana.secret)).data.invite;
  assert.equal((await api('POST', `/api/rooms/${roomA}/join`, bob.secret, {invite: inviteA})).status, 200);
  assert.equal((await api('POST', `/api/rooms/${roomB}/join`, carol.secret, {invite: inviteB})).status, 200);
  return {app, api, port, roomA, roomB, alice, bob, diana, carol, eve, inviteA, inviteB};
}

function observe(ws) {
  const messages = [];
  const pending = [];
  ws.on('message', raw => {
    const obj = JSON.parse(String(raw));
    messages.push(obj);
    for (const watcher of [...pending]) {
      if (watcher.pred(obj)) {
        clearTimeout(watcher.timer);
        pending.splice(pending.indexOf(watcher), 1);
        watcher.resolve(obj);
      }
    }
  });
  return {
    messages,
    next(pred, timeoutMs=2500) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const watcher = {pred, resolve, timer: null};
        watcher.timer = setTimeout(() => {
          const i = pending.indexOf(watcher);
          if (i >= 0) pending.splice(i, 1);
          reject(new Error('Timed out waiting for observed message'));
        }, timeoutMs);
        pending.push(watcher);
      });
    }
  };
}

async function connect(t, f, channel, secret, roomId, allowReject=false) {
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/${channel}`, {origin: 'http://localhost:5173'});
  t.after(() => ws.terminate());
  const monitor = observe(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({type: 'auth', token: secret, roomId}));
  if (!allowReject) await monitor.next(x => x.type === 'ready');
  return {ws, ...monitor};
}

const makeFrame = marker => 'data:image/jpeg;base64,' + Buffer.from('synthetic-t09-' + marker).toString('base64');

test('T-09: valid session does not grant cross-room membership or cross-room invites', async t => {
  const f = await fixture(t);
  for (const [token, room] of [
    [f.bob.secret, f.roomB], [f.carol.secret, f.roomA],
    [f.alice.secret, f.roomB], [f.diana.secret, f.roomA],
    [f.eve.secret, f.roomA], [f.eve.secret, f.roomB]
  ]) {
    assert.equal((await f.api('GET', `/api/rooms/${room}`, token)).status, 403);
  }
  // Use FRESH unconsumed invites so a rejection proves room binding, not expiry.
  const freshA = (await f.api('POST', `/api/rooms/${f.roomA}/invites`, f.alice.secret)).data.invite;
  const freshB = (await f.api('POST', `/api/rooms/${f.roomB}/invites`, f.diana.secret)).data.invite;
  assert.equal((await f.api('POST', `/api/rooms/${f.roomA}/join`, f.eve.secret, {invite: freshB})).status, 403);
  assert.equal((await f.api('POST', `/api/rooms/${f.roomB}/join`, f.eve.secret, {invite: freshA})).status, 403);
  assert.equal((await f.api('GET', `/api/rooms/${f.roomA}`, f.eve.secret)).status, 403);
  assert.equal((await f.api('GET', `/api/rooms/${f.roomB}`, f.eve.secret)).status, 403);
  // Positive control: the legitimate room A invite still works.
  assert.equal((await f.api('POST', `/api/rooms/${f.roomA}/join`, f.eve.secret, {invite: freshA})).status, 200);
  assert.equal((await f.api('GET', `/api/rooms/${f.roomB}`, f.eve.secret)).status, 403);
  // A user without membership in B cannot revoke B's viewer.
  assert.equal((await f.api('DELETE', `/api/rooms/${f.roomB}/members/${f.carol.user.id}`, f.alice.secret)).status, 403);
  assert.equal((await f.api('GET', `/api/rooms/${f.roomB}`, f.carol.secret)).status, 200);
});

test('T-09: cross-room signaling and gateway admission are denied', async t => {
  const f = await fixture(t);
  for (const channel of ['signal', 'media']) {
    for (const [token, room] of [[f.bob.secret, f.roomB], [f.carol.secret, f.roomA]]) {
      const c = await connect(t, f, channel, token, room, true);
      const [code] = await once(c.ws, 'close');
      assert.equal(code, 4001, `${channel}: unauthorized member must not attach to foreign room`);
      assert.equal(c.messages.some(m => m.type === 'ready'), false);
    }
  }
  const alice = await connect(t, f, 'signal', f.alice.secret, f.roomA);
  const bob = await connect(t, f, 'signal', f.bob.secret, f.roomA);
  const diana = await connect(t, f, 'signal', f.diana.secret, f.roomB);
  const carol = await connect(t, f, 'signal', f.carol.secret, f.roomB);
  const before = carol.messages.length;
  // A permitted sender cannot route an offer by guessing another room's target id.
  alice.ws.send(JSON.stringify({type:'signal', to:f.carol.user.id, data:{type:'offer',sdp:'synthetic'}}));
  assert.match((await alice.next(m => m.type === 'error')).error, /Invalid recipient/);
  await wait(110);
  assert.equal(carol.messages.length, before, 'Carol must not receive Alice signaling');
  // Positive controls: same-room signaling continues independently in both rooms.
  alice.ws.send(JSON.stringify({type:'signal', to:f.bob.user.id, data:{type:'offer',sdp:'from-A'}}));
  diana.ws.send(JSON.stringify({type:'signal', to:f.carol.user.id, data:{type:'offer',sdp:'from-B'}}));
  assert.equal((await bob.next(m=>m.type==='signal' && m.data.sdp==='from-A')).from, f.alice.user.id);
  assert.equal((await carol.next(m=>m.type==='signal' && m.data.sdp==='from-B')).from, f.diana.user.id);
});

test('T-09: media gateway delivers only within each room; revocation does not affect other room', async t => {
  const f = await fixture(t);
  const a = await connect(t, f, 'media', f.alice.secret, f.roomA);
  const b = await connect(t, f, 'media', f.bob.secret, f.roomA);
  const d = await connect(t, f, 'media', f.diana.secret, f.roomB);
  const c = await connect(t, f, 'media', f.carol.secret, f.roomB);
  const frameA = makeFrame('room-a');
  const frameB = makeFrame('room-b');
  a.ws.send(JSON.stringify({type:'frame', jpeg:frameA}));
  d.ws.send(JSON.stringify({type:'frame', jpeg:frameB}));
  assert.equal((await b.next(m=>m.type==='frame')).jpeg, frameA);
  assert.equal((await c.next(m=>m.type==='frame')).jpeg, frameB);
  await wait(100);
  assert.deepEqual(b.messages.filter(m=>m.type==='frame').map(m=>m.jpeg), [frameA]);
  assert.deepEqual(c.messages.filter(m=>m.type==='frame').map(m=>m.jpeg), [frameB]);
  const closedBob = once(b.ws, 'close');
  assert.equal((await f.api('DELETE', `/api/rooms/${f.roomA}/members/${f.bob.user.id}`, f.alice.secret)).status, 200);
  assert.equal((await closedBob)[0], 4003);
  await wait(175); // The JPEG lab intentionally throttles frames per publisher.
  const frameB2 = makeFrame('room-b-second');
  d.ws.send(JSON.stringify({type:'frame', jpeg:frameB2}));
  assert.equal((await c.next(m=>m.type==='frame'&&m.jpeg===frameB2)).jpeg, frameB2);
  assert.equal((await f.api('GET', `/api/rooms/${f.roomB}`, f.carol.secret)).status, 200);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});
