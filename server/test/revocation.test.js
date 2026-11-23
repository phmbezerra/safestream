import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

async function fixture(t) {
  const app = createApp();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => {
    for (const ws of app.wss.clients) ws.terminate();
    app.wss.close(() => app.server.close(resolve));
  }));
  const port = app.server.address().port;
  const api = async (method, path, token, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, data: await r.json() };
  };
  return { api, port };
}

function messageQueue(ws) {
  const backlog = [];
  const waiting = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    const hit = waiting.findIndex(x => x.predicate(msg));
    if (hit !== -1) {
      const [{ resolve, timer }] = waiting.splice(hit, 1);
      clearTimeout(timer);
      resolve(msg);
    } else backlog.push(msg);
  });
  return predicate => {
    const hit = backlog.findIndex(predicate);
    if (hit !== -1) return Promise.resolve(backlog.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { predicate, resolve, timer: null };
      item.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(item), 1);
        reject(new Error('Timed out waiting for websocket message'));
      }, 2000);
      waiting.push(item);
    });
  };
}

async function client(t, port, secret, room) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin: 'http://localhost:5173' });
  t.after(() => ws.terminate());
  const next = messageQueue(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token: secret, roomId: room }));
  await next(m => m.type === 'ready');
  return { ws, next };
}

test('T-03: owner receives explicit revocation notification; removed websocket closes', async t => {
  const { api, port } = await fixture(t);
  const publisher = (await api('POST', '/api/sessions', null, { label: 'Alice' })).data;
  const viewer = (await api('POST', '/api/sessions', null, { label: 'Bob' })).data;
  const roomId = (await api('POST', '/api/rooms', publisher.secret)).data.roomId;
  const invite = (await api('POST', `/api/rooms/${roomId}/invites`, publisher.secret)).data.invite;
  assert.equal((await api('POST', `/api/rooms/${roomId}/join`, viewer.secret, { invite })).status, 200);

  const ownerSocket = await client(t, port, publisher.secret, roomId);
  const viewerSocket = await client(t, port, viewer.secret, roomId);
  // Avoid relying on UI or on client willingly closing a WebRTC connection.
  const closed = once(viewerSocket.ws, 'close');
  const revoked = api('DELETE', `/api/rooms/${roomId}/members/${viewer.user.id}`, publisher.secret);
  const notice = await ownerSocket.next(m => m.type === 'peer-revoked');
  assert.equal(notice.id, viewer.user.id);
  assert.equal(notice.reason, 'membership-revoked');
  assert.equal((await revoked).status, 200);
  const [closeCode] = await closed;
  assert.equal(closeCode, 4003);
  assert.equal((await api('GET', `/api/rooms/${roomId}`, viewer.secret)).status, 403);

  // Reusing the revoked session must not reauthorize signaling.
  const retry = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin: 'http://localhost:5173' });
  t.after(() => retry.terminate());
  await once(retry, 'open');
  const retryClose = once(retry, 'close');
  retry.send(JSON.stringify({ type: 'auth', token: viewer.secret, roomId }));
  assert.equal((await retryClose)[0], 4001 /* rejected during authentication */);
});

test('T-03 limitation: signaling notification is not proof of media-track termination', async t => {
  const { api, port } = await fixture(t);
  const publisher = (await api('POST', '/api/sessions', null, { label: 'Alice' })).data;
  const viewer = (await api('POST', '/api/sessions', null, { label: 'Bob' })).data;
  const roomId = (await api('POST', '/api/rooms', publisher.secret)).data.roomId;
  const invite = (await api('POST', `/api/rooms/${roomId}/invites`, publisher.secret)).data.invite;
  await api('POST', `/api/rooms/${roomId}/join`, viewer.secret, { invite });
  const alice = await client(t, port, publisher.secret, roomId);
  await client(t, port, viewer.secret, roomId);
  await api('DELETE', `/api/rooms/${roomId}/members/${viewer.user.id}`, publisher.secret);
  const notice = await alice.next(m => m.type === 'peer-revoked');
  assert.equal(notice.id, viewer.user.id);
  // Intentional bound: there is NO assertion that the peer's video stopped.
  // A malicious/noncooperative publisher can ignore this notification.
});
