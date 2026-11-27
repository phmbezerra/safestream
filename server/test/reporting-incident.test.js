import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const token = () => randomBytes(32).toString('base64url');

async function launch(options) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  const base = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;

  async function api(method, route, secret, body, idem) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(secret ? {
          Authorization: `Bearer ${secret}`
        } : {}),
        ...(body !== undefined ? {
          'Content-Type': 'application/json'
        } : {}),
        ...(idem ? {
          'Idempotency-Key': idem
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

  async function close() {
    if (closed) return;
    closed = true;

    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();

    await new Promise(r => app.wss.close(r));
    await new Promise(r => app.mediaWss.close(r));
    await new Promise(r => app.server.close(r));
  }

  return {api, close};
}

test('T-15: complete synthetic incident survives stop and restart', async t => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t15-incident-')
  );

  t.after(() => {
    fs.rmSync(dir, {recursive:true, force:true});
  });

  const reportStateFile = path.join(dir, 'reports.json');
  const stateFile = path.join(dir, 'rooms.json');
  const moderatorToken = token();
  const requestKey = token();

  const options = {
    stateFile,
    reportStateFile,
    moderatorToken
  };

  const firstServer = await launch(options);
  let secondServer = null;

  try {
    const session = async label => {
      const result = await firstServer.api(
        'POST', '/api/sessions', null, {label}
      );
      assert.equal(result.status, 201);
      return result.data.secret;
    };

    const alice = await session('Alice');
    const bob = await session('Bob');
    const outsider = await session('Outsider');

    const created = await firstServer.api(
      'POST', '/api/rooms', alice
    );

    assert.equal(created.status, 201);
    const room = created.data.roomId;

    const invite = await firstServer.api(
      'POST', `/api/rooms/${room}/invites`, alice
    );

    assert.equal(invite.status, 201);

    assert.equal(
      (await firstServer.api(
        'POST', `/api/rooms/${room}/join`,
        bob, {invite:invite.data.invite}
      )).status,
      200
    );

    const route = `/api/rooms/${room}/reports`;

    const report = await firstServer.api(
      'POST', route, bob,
      {category:'privacy'}, requestKey
    );

    assert.equal(report.status, 201);
    assert.equal(report.data.status, 'submitted');

    const reportId = report.data.id;

    const duplicate = await firstServer.api(
      'POST', route, bob,
      {category:'privacy'}, requestKey
    );

    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.id, reportId);

    const readRoute = `/api/reports/${reportId}`;
    const modRoute = `/api/moderation/reports/${reportId}`;

    assert.equal(
      (await firstServer.api(
        'GET', readRoute, outsider
      )).status,
      404
    );

    assert.equal(
      (await firstServer.api(
        'GET', '/api/moderation/reports', alice
      )).status,
      401
    );

    const triaged = await firstServer.api(
      'POST', `${modRoute}/transitions`,
      moderatorToken,
      {status:'triaged'}
    );

    assert.equal(triaged.status, 200);

    const stopped = await firstServer.api(
      'POST',
      `/api/rooms/${room}/emergency-stop`,
      alice
    );

    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.stopped, true);

    assert.equal(
      (await firstServer.api(
        'GET', readRoute, bob
      )).status,
      200
    );

    await firstServer.close();

    secondServer = await launch(options);

    // A stopped room cannot be restored.
    assert.equal(
      (await secondServer.api(
        'GET', `/api/rooms/${room}`, alice
      )).status,
      404
    );

    // But Bob can still consult his report.
    const recovered = await secondServer.api(
      'GET', readRoute, bob
    );

    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.status, 'triaged');

    const resolved = await secondServer.api(
      'POST', `${modRoute}/transitions`,
      moderatorToken,
      {status:'resolved'}
    );

    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.status, 'resolved');

    const history = await secondServer.api(
      'GET', `${modRoute}/audit`, moderatorToken
    );

    assert.equal(history.status, 200);
    assert.equal(history.data.events.length, 3);

    assert.deepEqual(
      history.data.events.map(event => event.to),
      ['submitted', 'triaged', 'resolved']
    );

    const queue = await secondServer.api(
      'GET', '/api/moderation/reports',
      moderatorToken
    );

    assert.equal(queue.status, 200);
    assert.equal(queue.data.total, 1);

    const onDisk = fs.readFileSync(
      reportStateFile, 'utf8'
    );

    const saved = JSON.parse(onDisk);

    assert.equal(saved.records.length, 1);
    assert.equal(saved.records[0].events.length, 3);
    assert.equal(saved.records[0].report.status, 'resolved');

    assert.equal(onDisk.includes(requestKey), false);
    assert.equal(onDisk.includes(moderatorToken), false);

    assert.equal(
      (await secondServer.api(
        'GET', readRoute, outsider
      )).status,
      404
    );

    // Retrying after the room was stopped cannot reopen it.
    assert.equal(
      (await secondServer.api(
        'POST', route, bob,
        {category:'privacy'}, requestKey
      )).status,
      404
    );

  } finally {
    await firstServer.close();
    if (secondServer) await secondServer.close();
  }
});
