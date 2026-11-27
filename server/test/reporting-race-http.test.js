import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';

const token = () => randomBytes(32).toString('base64url');

test('T-15: emergency stop during report body denies submission', async t => {
  const moderatorToken = token();
  const app = createApp({moderatorToken});

  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  const base = `http://127.0.0.1:${app.server.address().port}`;
  let pendingRequest = null;

  t.after(async () => {
    if (pendingRequest && !pendingRequest.destroyed) {
      pendingRequest.destroy();
    }

    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();

    await new Promise(r => app.wss.close(r));
    await new Promise(r => app.mediaWss.close(r));
    await new Promise(r => app.server.close(r));
  });

  async function api(method, route, bearer, body) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(bearer ? {
          Authorization: `Bearer ${bearer}`
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
      'POST', '/api/sessions', null, {label}
    );
    assert.equal(result.status, 201);
    return result.data.secret;
  }

  const owner = await session('Owner');
  const viewer = await session('Viewer');

  const roomResult = await api(
    'POST', '/api/rooms', owner
  );
  assert.equal(roomResult.status, 201);

  const room = roomResult.data.roomId;

  const invitation = await api(
    'POST', `/api/rooms/${room}/invites`, owner
  );
  assert.equal(invitation.status, 201);

  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${room}/join`,
      viewer,
      {invite: invitation.data.invite}
    )).status,
    200
  );

  const reportRoute = `/api/rooms/${room}/reports`;

  // Observe the server receiving the partial request.
  const started = once(app.server, 'request');

  const reportResponse = new Promise((resolve, reject) => {
    pendingRequest = httpRequest(base + reportRoute, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${viewer}`,
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
      }
    }, response => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('error', reject);

      response.on('end', () => resolve({
        status: response.statusCode,
        data: JSON.parse(body)
      }));
    });

    pendingRequest.on('error', reject);
  });

  // Begin the body but DO NOT finish it.
  pendingRequest.write('{"category":"pri');

  const [incoming] = await started;

  assert.equal(incoming.method, 'POST');
  assert.equal(incoming.url, reportRoute);

  // The server is now awaiting the rest of the body.
  // Emergency Stop must invalidate the room.
  const stopped = await api(
    'POST',
    `/api/rooms/${room}/emergency-stop`,
    owner
  );

  assert.equal(stopped.status, 200);

  // Finish the body only AFTER the room was stopped.
  pendingRequest.end('vacy"}');

  const result = await reportResponse;

  assert.equal(result.status, 404);

  // No report should have been created.
  const queue = await api(
    'GET',
    '/api/moderation/reports',
    moderatorToken
  );

  assert.equal(queue.status, 200);
  assert.equal(queue.data.total, 0);
});
