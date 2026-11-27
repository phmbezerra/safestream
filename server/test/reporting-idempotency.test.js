import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReportingStore } from '../src/reporting.js';
import { readReportState } from '../src/report-state-file.js';
import { createApp } from '../src/app.js';

const key = () => randomBytes(32).toString('base64url');

const roomId = 'R'.repeat(12);
const reporterId = 'A'.repeat(32);

function input(idempotencyKey, category = 'privacy') {
  return {
    roomId,
    reporterId,
    category,
    idempotencyKey
  };
}

test('T-15 idempotency: retries reuse persisted report', t => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t15-idem-')
  );

  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));

  const file = path.join(dir, 'reports.json');
  const requestKey = key();
  const clock = Date.UTC(2026, 10, 27, 18);

  const firstStore = createReportingStore({
    stateFile: file,
    now: () => clock,
    maxReports: 1
  });

  const original = firstStore.submit(input(requestKey));
  const retry = firstStore.submit(input(requestKey));

  assert.deepEqual(retry, original);

  let persisted = readReportState(file);

  assert.equal(persisted.records.length, 1);
  assert.equal(persisted.records[0].events.length, 1);
  assert.match(
    persisted.records[0].report.idempotencyHash,
    /^[a-f0-9]{64}$/
  );

  assert.equal(
    fs.readFileSync(file, 'utf8').includes(requestKey),
    false
  );

  const restarted = createReportingStore({
    stateFile: file,
    now: () => clock,
    maxReports: 1
  });

  assert.deepEqual(
    restarted.submit(input(requestKey)),
    original
  );

  assert.throws(
    () => restarted.submit(input(requestKey, 'coercion')),
    error => error.status === 409
  );

  persisted = readReportState(file);
  assert.equal(persisted.records.length, 1);
});

test('T-15 idempotency: key is scoped to reporter and room', () => {
  const store = createReportingStore();
  const requestKey = key();

  const a = store.submit(input(requestKey));

  const b = store.submit({
    ...input(requestKey),
    reporterId: 'B'.repeat(32)
  });

  const c = store.submit({
    ...input(requestKey),
    roomId: 'S'.repeat(12)
  });

  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);

  assert.throws(
    () => store.submit(input('not-a-valid-key')),
    error => error.status === 400
  );

  const withoutKey1 = store.submit({
    roomId,
    reporterId,
    category: 'other'
  });

  const withoutKey2 = store.submit({
    roomId,
    reporterId,
    category: 'other'
  });

  assert.notEqual(withoutKey1.id, withoutKey2.id);
});

test('T-15 idempotency: HTTP retries create one occurrence', async t => {
  const moderatorToken = key();
  const app = createApp({ moderatorToken });

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

  async function api(method, route, token, body, idemKey) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token ? {
          Authorization: `Bearer ${token}`
        } : {}),
        ...(body !== undefined ? {
          'Content-Type': 'application/json'
        } : {}),
        ...(idemKey ? {
          'Idempotency-Key': idemKey
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

  const session = async label => {
    const result = await api(
      'POST', '/api/sessions', null, {label}
    );
    assert.equal(result.status, 201);
    return result.data.secret;
  };

  const owner = await session('Owner');
  const viewer = await session('Viewer');

  const room = (await api(
    'POST', '/api/rooms', owner
  )).data.roomId;

  const invite = (await api(
    'POST', `/api/rooms/${room}/invites`, owner
  )).data.invite;

  assert.equal(
    (await api(
      'POST', `/api/rooms/${room}/join`,
      viewer, {invite}
    )).status,
    200
  );

  const route = `/api/rooms/${room}/reports`;
  const requestKey = key();

  const first = await api(
    'POST', route, viewer,
    {category:'privacy'}, requestKey
  );

  const retry = await api(
    'POST', route, viewer,
    {category:'privacy'}, requestKey
  );

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.data.id, first.data.id);

  assert.equal(
    (await api(
      'POST', route, viewer,
      {category:'other'}, requestKey
    )).status,
    409
  );

  const queue = await api(
    'GET', '/api/moderation/reports',
    moderatorToken
  );

  assert.equal(queue.status, 200);
  assert.equal(queue.data.total, 1);

  const history = await api(
    'GET',
    `/api/moderation/reports/${first.data.id}/audit`,
    moderatorToken
  );

  assert.equal(history.status, 200);
  assert.equal(history.data.events.length, 1);

  const preflight = await fetch(base + route, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Headers': 'Idempotency-Key'
    }
  });

  assert.equal(preflight.status, 200);
  assert.match(
    preflight.headers.get('Access-Control-Allow-Headers'),
    /Idempotency-Key/i
  );
});
