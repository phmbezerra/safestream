import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { readReportState } from '../src/report-state-file.js';

const secret = () => randomBytes(32).toString('base64url');

function paths(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t15-recovery-')
  );

  t.after(() => fs.rmSync(dir, {
    recursive: true,
    force: true
  }));

  return {
    roomStateFile: path.join(dir, 'rooms.json'),
    reportStateFile: path.join(dir, 'reports.json')
  };
}

async function launch(options) {
  const app = createApp(options);

  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  const base = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;

  async function api(method, route, bearer = null, body) {
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

  async function close() {
    if (closed) return;
    closed = true;

    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();

    await new Promise(resolve => app.wss.close(resolve));
    await new Promise(resolve => app.mediaWss.close(resolve));
    await new Promise(resolve => app.server.close(resolve));
  }

  return { api, close };
}

async function makeReport(api) {
  const session = async label => {
    const result = await api(
      'POST', '/api/sessions', null, {label}
    );
    assert.equal(result.status, 201);
    return result.data.secret;
  };

  const owner = await session('Owner');
  const viewer = await session('Viewer');

  const createdRoom = await api(
    'POST', '/api/rooms', owner
  );

  assert.equal(createdRoom.status, 201);
  const room = createdRoom.data.roomId;

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

  const report = await api(
    'POST',
    `/api/rooms/${room}/reports`,
    viewer,
    {category: 'privacy'}
  );

  assert.equal(report.status, 201);

  return {
    owner,
    viewer,
    room,
    reportId: report.data.id
  };
}

// Simulate a filesystem write failure by temporarily
// replacing the destination file with a directory.
async function blockedWrite(file, action) {
  const backup = file + '.test-backup';

  fs.renameSync(file, backup);

  try {
    fs.mkdirSync(file);
    return await action();
  } finally {
    if (fs.existsSync(file)) {
      fs.rmdirSync(file);
    }
    fs.renameSync(backup, file);
  }
}

test('T-15 recovery: reports survive restart, old rooms do not', async t => {
  const {roomStateFile, reportStateFile} = paths(t);
  const moderatorToken = secret();

  const options = {
    stateFile: roomStateFile,
    reportStateFile,
    moderatorToken
  };

  const first = await launch(options);
  let second;

  try {
    const {owner, viewer, room, reportId} =
      await makeReport(first.api);

    const transition = await first.api(
      'POST',
      `/api/moderation/reports/${reportId}/transitions`,
      moderatorToken,
      {status: 'triaged'}
    );

    assert.equal(transition.status, 200);

    await first.close();

    second = await launch(options);

    assert.equal(
      (await second.api(
        'GET',
        `/api/rooms/${room}`,
        owner
      )).status,
      404
    );

    const report = await second.api(
      'GET',
      `/api/reports/${reportId}`,
      viewer
    );

    assert.equal(report.status, 200);
    assert.equal(report.data.status, 'triaged');

    const audit = await second.api(
      'GET',
      `/api/moderation/reports/${reportId}/audit`,
      moderatorToken
    );

    assert.equal(audit.status, 200);
    assert.equal(audit.data.events.length, 2);
    assert.equal(audit.data.events[1].to, 'triaged');

    const queue = await second.api(
      'GET',
      '/api/moderation/reports',
      moderatorToken
    );

    assert.equal(queue.status, 200);
    assert.equal(queue.data.total, 1);
  } finally {
    await first.close();
    if (second) await second.close();
  }
});

test('T-15 recovery: failed submission is not acknowledged', async t => {
  const {roomStateFile, reportStateFile} = paths(t);
  const moderatorToken = secret();

  const app = await launch({
    stateFile: roomStateFile,
    reportStateFile,
    moderatorToken
  });

  try {
    const {viewer, room} = await makeReport(app.api);

    const failed = await blockedWrite(
      reportStateFile,
      () => app.api(
        'POST',
        `/api/rooms/${room}/reports`,
        viewer,
        {category: 'coercion'}
      )
    );

    assert.equal(failed.status, 500);

    const queue = await app.api(
      'GET',
      '/api/moderation/reports',
      moderatorToken
    );

    assert.equal(queue.status, 200);
    assert.equal(queue.data.total, 1);

    assert.equal(
      readReportState(reportStateFile).records.length,
      1
    );
  } finally {
    await app.close();
  }
});

test('T-15 recovery: failed transition preserves audit', async t => {
  const {roomStateFile, reportStateFile} = paths(t);
  const moderatorToken = secret();

  const app = await launch({
    stateFile: roomStateFile,
    reportStateFile,
    moderatorToken
  });

  try {
    const {viewer, reportId} = await makeReport(app.api);

    const failed = await blockedWrite(
      reportStateFile,
      () => app.api(
        'POST',
        `/api/moderation/reports/${reportId}/transitions`,
        moderatorToken,
        {status: 'triaged'}
      )
    );

    assert.equal(failed.status, 500);

    const report = await app.api(
      'GET',
      `/api/reports/${reportId}`,
      viewer
    );

    assert.equal(report.status, 200);
    assert.equal(report.data.status, 'submitted');

    const audit = await app.api(
      'GET',
      `/api/moderation/reports/${reportId}/audit`,
      moderatorToken
    );

    assert.equal(audit.status, 200);
    assert.equal(audit.data.events.length, 1);

    assert.equal(
      readReportState(reportStateFile)
        .records[0].report.status,
      'submitted'
    );
  } finally {
    await app.close();
  }
});

test('T-15 recovery: invalid state refuses startup', t => {
  const {roomStateFile, reportStateFile} = paths(t);

  fs.writeFileSync(
    reportStateFile,
    '{broken',
    'utf8'
  );

  assert.throws(
    () => createApp({stateFile:roomStateFile, reportStateFile}),
    /SafeStream report state invalid: malformed JSON/
  );

  assert.throws(
    () => createApp({
      stateFile: roomStateFile,
      reportStateFile: roomStateFile
    }),
    /paths must differ/
  );
});


test('T-15 recovery: persistent reports require durable sessions', t => {
  const {reportStateFile} = paths(t);

  assert.throws(
    () => createApp({reportStateFile}),
    /requires session persistence/
  );
});
