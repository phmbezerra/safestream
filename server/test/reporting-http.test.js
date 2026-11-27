import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

async function fixture(t) {
  const app = createApp();

  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  t.after(async () => {
    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();

    await new Promise(resolve => app.wss.close(resolve));
    await new Promise(resolve => app.mediaWss.close(resolve));
    await new Promise(resolve => app.server.close(resolve));
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function api(method, route, secret, body) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(secret ? {
          Authorization: `Bearer ${secret}`
        } : {}),
        ...(body !== undefined ? {
          'Content-Type': 'application/json'
        } : {})
      },
      ...(body !== undefined ? {
        body: JSON.stringify(body)
      } : {})
    });

    return {
      status: response.status,
      data: await response.json()
    };
  }

  async function session(label) {
    const result = await api(
      'POST', '/api/sessions', null, { label }
    );
    assert.equal(result.status, 201);
    return result.data.secret;
  }

  async function setupRoom() {
    const alice = await session('Alice');
    const bob = await session('Bob');
    const outsider = await session('Outsider');

    const created = await api(
      'POST', '/api/rooms', alice
    );

    assert.equal(created.status, 201);
    const room = created.data.roomId;

    const invitation = await api(
      'POST', `/api/rooms/${room}/invites`, alice
    );

    assert.equal(invitation.status, 201);

    const joined = await api(
      'POST', `/api/rooms/${room}/join`,
      bob, { invite: invitation.data.invite }
    );

    assert.equal(joined.status, 200);

    return { alice, bob, outsider, room };
  }

  return { api, setupRoom };
}

test('T-15 HTTP: report ownership and identity cannot be forged', async t => {
  const { api, setupRoom } = await fixture(t);
  const { alice, bob, outsider, room } = await setupRoom();

  const route = `/api/rooms/${room}/reports`;

  assert.equal(
    (await api('POST', route, null, {
      category: 'privacy'
    })).status,
    401
  );

  assert.equal(
    (await api('POST', route, outsider, {
      category: 'privacy'
    })).status,
    403
  );

  const created = await api(
    'POST', route, bob, { category: 'privacy' }
  );

  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'submitted');
  assert.equal(created.data.category, 'privacy');

  const reportId = created.data.id;
  const readRoute = `/api/reports/${reportId}`;

  assert.equal(
    (await api('GET', readRoute, bob)).status,
    200
  );

  assert.equal(
    (await api('GET', readRoute, alice)).status,
    404
  );

  assert.equal(
    (await api('GET', readRoute, outsider)).status,
    404
  );

  assert.equal(
    (await api('GET', readRoute, null)).status,
    401
  );

  assert.equal(
    (await api('POST', route, bob, {
      category: 'privacy',
      reporterId: 'A'.repeat(32)
    })).status,
    400
  );

  assert.equal(
    (await api('POST', route, bob, {
      category: 'other',
      description: 'private information'
    })).status,
    400
  );

  assert.equal(
    (await api('POST', route, bob, {
      category: 'unknown'
    })).status,
    400
  );

  assert.deepEqual(
    Object.keys(created.data).sort(),
    [
      'id', 'roomId', 'category',
      'status', 'createdAt', 'updatedAt'
    ].sort()
  );
});

test('T-15 HTTP: report survives revocation and Emergency Stop', async t => {
  const { api, setupRoom } = await fixture(t);
  const { alice, bob, room } = await setupRoom();

  const created = await api(
    'POST',
    `/api/rooms/${room}/reports`,
    bob,
    { category: 'harassment' }
  );

  assert.equal(created.status, 201);

  const readRoute = `/api/reports/${created.data.id}`;

  const membership = await api(
    'GET', `/api/rooms/${room}`, alice
  );

  assert.equal(membership.status, 200);

  const bobMember = membership.data.members.find(
    member => member.label === 'Bob'
  );

  assert.ok(bobMember);

  const revoked = await api(
    'DELETE',
    `/api/rooms/${room}/members/${bobMember.id}`,
    alice
  );

  assert.equal(revoked.status, 200);

  // Revocation prevents new reports.
  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${room}/reports`,
      bob,
      { category: 'other' }
    )).status,
    403
  );

  // The reporter can still consult an earlier report.
  assert.equal(
    (await api('GET', readRoute, bob)).status,
    200
  );

  const stopped = await api(
    'POST',
    `/api/rooms/${room}/emergency-stop`,
    alice
  );

  assert.equal(stopped.status, 200);

  assert.equal(
    (await api('GET', readRoute, bob)).status,
    200
  );

  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${room}/reports`,
      bob,
      { category: 'privacy' }
    )).status,
    404
  );
});
