import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

test('T-14: only room owner can permanently emergency-stop a room', async t => {
  const app = createApp();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  t.after(() => new Promise(resolve =>
    app.server.close(resolve)
  ));

  const port = app.server.address().port;

  async function api(method, path, secret, body) {
    const response = await fetch(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? {
            Authorization: `Bearer ${secret}`
          } : {})
        },
        body: body === undefined
          ? undefined
          : JSON.stringify(body)
      }
    );

    return {
      status: response.status,
      data: await response.json()
    };
  }

  const alice = (await api(
    'POST', '/api/sessions', null, { label: 'Alice' }
  )).data;

  const bob = (await api(
    'POST', '/api/sessions', null, { label: 'Bob' }
  )).data;

  const roomId = (await api(
    'POST', '/api/rooms', alice.secret
  )).data.roomId;

  const invite = (await api(
    'POST',
    `/api/rooms/${roomId}/invites`,
    alice.secret
  )).data.invite;

  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${roomId}/join`,
      bob.secret,
      { invite }
    )).status,
    200
  );

  const stopPath =
    `/api/rooms/${roomId}/emergency-stop`;

  // An anonymous caller must not stop the room.
  assert.equal(
    (await api('POST', stopPath)).status,
    401
  );

  // A viewer must not stop someone else's room.
  assert.equal(
    (await api('POST', stopPath, bob.secret)).status,
    403
  );

  // Only Alice can terminate her room.
  assert.equal(
    (await api('POST', stopPath, alice.secret)).status,
    200
  );

  // Terminated rooms must deny old permissions.
  assert.equal(
    (await api(
      'GET', `/api/rooms/${roomId}`,
      alice.secret
    )).status,
    404
  );

  assert.equal(
    (await api(
      'GET', `/api/rooms/${roomId}`,
      bob.secret
    )).status,
    404
  );

  // New invitations must be impossible.
  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${roomId}/invites`,
      alice.secret
    )).status,
    404
  );
});
test('T-14: emergency stop forcibly closes signaling and legacy media sockets', {timeout:10000}, async t => {
  const { WebSocket } = await import('ws');
  const app = createApp();
  const sockets = [];

  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => app.server.close(resolve));
  });

  const port = app.server.address().port;

  async function api(method, path, secret, body) {
    const response = await fetch(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }
    );

    return { status: response.status, data: await response.json() };
  }

  const alice = (await api(
    'POST', '/api/sessions', null, {label:'Alice'}
  )).data;

  const bob = (await api(
    'POST', '/api/sessions', null, {label:'Bob'}
  )).data;

  const roomId = (await api(
    'POST', '/api/rooms', alice.secret
  )).data.roomId;

  const invite = (await api(
    'POST',
    `/api/rooms/${roomId}/invites`,
    alice.secret
  )).data.invite;

  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${roomId}/join`,
      bob.secret,
      {invite}
    )).status,
    200
  );

  async function connect(endpoint, secret) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/${endpoint}`,
      {origin:'http://localhost:5173'}
    );

    sockets.push(ws);
    await once(ws, 'open');

    ws.send(JSON.stringify({
      type:'auth',
      roomId,
      token:secret
    }));

    const [data] = await once(ws, 'message');
    assert.equal(JSON.parse(String(data)).type, 'ready');

    return ws;
  }

  const aliceSignal = await connect('signal', alice.secret);
  const bobSignal = await connect('signal', bob.secret);
  const bobMedia = await connect('media', bob.secret);

  // Register close listeners BEFORE triggering the stop.
  const closed = [
    once(aliceSignal, 'close'),
    once(bobSignal, 'close'),
    once(bobMedia, 'close')
  ];

  const stop = await api(
    'POST',
    `/api/rooms/${roomId}/emergency-stop`,
    alice.secret
  );

  assert.equal(stop.status, 200);
  assert.equal(stop.data.stopped, true);

  const results = await Promise.all(closed);

  for (const [code] of results) {
    assert.equal(code, 4004);
  }

  // Old room access must remain invalid.
  assert.equal(
    (await api(
      'GET', `/api/rooms/${roomId}`, bob.secret
    )).status,
    404
  );
});
test('T-14: emergency-stopped rooms are not restored after server restart', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {createStore} = await import('../src/core.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safestream-t14-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));

  const stateFile = path.join(dir, 'state.json');
  const store = createStore({stateFile});

  const alice = store.session('Alice');
  const bob = store.session('Bob');
  const room = store.room(alice.user);

  const invite = store.invite(room, alice.user);
  store.join(room, bob.user, invite);

  const result = store.emergencyStop(room, alice.user);

  assert.equal(result.stopped, true);
  assert.equal(result.roomId, room.id);

  // Simulate restarting the Node application.
  const restored = createStore({stateFile});

  // Demo identities survive, but the terminated room does not.
  assert.equal(
    restored.identity(alice.secret).id,
    alice.user.id
  );

  assert.equal(
    restored.identity(bob.secret).id,
    bob.user.id
  );

  assert.throws(
    () => restored.get(room.id),
    error => error.status === 404
  );
});

test('T-14: failed persistence must not falsely complete emergency stop', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {createStore} = await import('../src/core.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safestream-t14-failure-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));

  const stateFile = path.join(dir, 'state.json');
  const store = createStore({stateFile});

  const alice = store.session('Alice');
  const bob = store.session('Bob');
  const room = store.room(alice.user);

  const invite = store.invite(room, alice.user);
  store.join(room, bob.user, invite);

  const messages = [];
  let closed = false;

  const fakePeer = {
    readyState: 1,
    send(message) {
      messages.push(message);
    },
    close() {
      closed = true;
    }
  };

  room.peers.set(bob.user.id, fakePeer);

  // Simulate an unwritable state destination.
  fs.unlinkSync(stateFile);
  fs.mkdirSync(stateFile);

  // Disk failure must be reported, not hidden.
  assert.throws(
    () => store.emergencyStop(room, alice.user),
    error => error.status === 503
  );

  // The room must be denied in memory despite the disk failure.
  assert.throws(
    () => store.get(room.id),
    error => error.status === 404
  );

  // Live signaling must be forcibly terminated.
  assert.deepEqual(
    messages.map(message => JSON.parse(message)),
    [{
      type: 'room-stopped',
      reason: 'emergency-stop'
    }]
  );
  assert.equal(closed, true);

  // The session identity may remain, but room access is gone.
  assert.equal(store.identity(bob.secret).id, bob.user.id);
});
