import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';

test('T-14: HTTP persistence failure blocks room and closes signaling', {
  timeout: 10000
}, async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t14-')
  );
  const active = path.join(root, 'active');
  const backup = path.join(root, 'backup');

  fs.mkdirSync(active);
  const stateFile = path.join(active, 'state.json');
  const app = createApp({ stateFile });
  let socket;

  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');

    const base = `http://127.0.0.1:${app.server.address().port}`;

    async function api(method, route, secret, body) {
      const headers = {};
      if (secret) headers.Authorization = `Bearer ${secret}`;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(base + route, {
        method,
        headers,
        ...(body !== undefined
          ? { body: JSON.stringify(body) }
          : {})
      });

      return {
        status: response.status,
        data: await response.json()
      };
    }

    const session = await api(
      'POST', '/api/sessions', null, { label: 'Alice' }
    );
    assert.equal(session.status, 201);

    const secret = session.data.secret;

    const created = await api(
      'POST', '/api/rooms', secret, {}
    );
    assert.equal(created.status, 201);

    const roomId = created.data.roomId;

    socket = new WebSocket(
      base.replace('http://', 'ws://') + '/signal',
      { headers: { origin: 'http://localhost:5173' } }
    );

    await once(socket, 'open');

    const ready = once(socket, 'message');
    socket.send(JSON.stringify({
      type: 'auth',
      roomId,
      token: secret
    }));

    const [readyBuffer] = await ready;
    assert.equal(
      JSON.parse(String(readyBuffer)).type,
      'ready'
    );

    // Simulate a broken persistence directory.
    // Original state is preserved in a temporary backup.
    fs.renameSync(active, backup);
    fs.writeFileSync(active, 'blocked');

    const closed = once(socket, 'close');

    const result = await api(
      'POST',
      `/api/rooms/${roomId}/emergency-stop`,
      secret,
      {}
    );

    assert.equal(result.status, 503);
    assert.match(result.data.error, /not persisted/i);

    const [closeCode] = await closed;
    assert.equal(closeCode, 4004);

    const after = await api(
      'GET', `/api/rooms/${roomId}`, secret
    );

    assert.equal(after.status, 404);
    assert.equal(app.store.rooms.has(roomId), false);

    // The original disk snapshot still has the room.
    // This is the recovery hazard we must address next.
    const oldState = JSON.parse(
      fs.readFileSync(path.join(backup, 'state.json'), 'utf8')
    );

    assert.ok(
      oldState.rooms.some(r => r.id === roomId),
      'Expected stale room in failed persistence snapshot'
    );
  } finally {
    if (socket) socket.terminate();

    await new Promise(resolve => {
      app.server.close(resolve);
    });

    fs.rmSync(root, { recursive: true, force: true });
  }
});
