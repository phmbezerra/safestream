import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

const newToken = () =>
  randomBytes(32).toString('base64url');

async function fixture(t, moderatorToken = null) {
  const app = createApp({ moderatorToken });

  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  t.after(async () => {
    for (const ws of app.wss.clients) ws.terminate();
    for (const ws of app.mediaWss.clients) ws.terminate();

    await new Promise(r => app.wss.close(r));
    await new Promise(r => app.mediaWss.close(r));
    await new Promise(r => app.server.close(r));
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function api(method, path, token, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? {
          Authorization: `Bearer ${token}`
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
      status: res.status,
      data: await res.json()
    };
  }

  async function session(label) {
    const result = await api(
      'POST', '/api/sessions', null, {label}
    );
    assert.equal(result.status, 201);
    return result.data.secret;
  }

  async function createReport() {
    const owner = await session('Owner');
    const viewer = await session('Viewer');

    const roomResult = await api(
      'POST', '/api/rooms', owner
    );
    assert.equal(roomResult.status, 201);

    const room = roomResult.data.roomId;

    const inviteResult = await api(
      'POST', `/api/rooms/${room}/invites`, owner
    );
    assert.equal(inviteResult.status, 201);

    assert.equal(
      (await api(
        'POST', `/api/rooms/${room}/join`,
        viewer, {invite:inviteResult.data.invite}
      )).status,
      200
    );

    const report = await api(
      'POST', `/api/rooms/${room}/reports`,
      viewer, {category:'privacy'}
    );

    assert.equal(report.status, 201);

    return {
      owner,
      viewer,
      room,
      reportId:report.data.id
    };
  }

  return { api, session, createReport };
}

test('T-15 HTTP: moderator API is disabled by default', async t => {
  const {api,session,createReport} = await fixture(t);

  const report = await createReport();
  const fakeModerator = await session('Moderator');

  const queue = '/api/moderation/reports';

  assert.equal(
    (await api('GET',queue,null)).status,401
  );

  assert.equal(
    (await api('GET',queue,fakeModerator)).status,401
  );

  assert.equal(
    (await api('GET',queue,report.owner)).status,401
  );

  assert.equal(
    (await api('GET',
      `/api/moderation/reports/${report.reportId}/audit`,
      fakeModerator
    )).status,
    401
  );

  assert.equal(
    (await api('POST',
      `/api/moderation/reports/${report.reportId}/transitions`,
      report.owner,
      {status:'triaged'}
    )).status,
    401
  );
});

test('T-15 HTTP: moderator token controls queue and audit', async t => {
  const moderatorToken = newToken();
  const {api,createReport} = await fixture(
    t,moderatorToken
  );

  const report = await createReport();

  const queue = '/api/moderation/reports';
  const transitions =
    `/api/moderation/reports/${report.reportId}/transitions`;
  const audit =
    `/api/moderation/reports/${report.reportId}/audit`;

  assert.equal(
    (await api('GET',queue,report.owner)).status,
    401
  );

  assert.equal(
    (await api('GET',queue,newToken())).status,
    401
  );

  const listed = await api(
    'GET',`${queue}?limit=1&offset=0`,moderatorToken
  );

  assert.equal(listed.status,200);
  assert.equal(listed.data.total,1);
  assert.equal(listed.data.reports.length,1);

  assert.equal(
    Object.hasOwn(listed.data.reports[0],'reporterId'),
    false
  );

  assert.equal(
    (await api('GET',`${queue}?limit=999`,moderatorToken)).status,
    400
  );

  assert.equal(
    (await api('POST',transitions,moderatorToken,{
      status:'resolved'
    })).status,
    409
  );

  assert.equal(
    (await api('POST',transitions,moderatorToken,{
      status:'triaged',
      actorId:'forged'
    })).status,
    400
  );

  const triaged = await api(
    'POST',transitions,moderatorToken,{
      status:'triaged'
    }
  );

  assert.equal(triaged.status,200);
  assert.equal(triaged.data.status,'triaged');

  const resolved = await api(
    'POST',transitions,moderatorToken,{
      status:'resolved'
    }
  );

  assert.equal(resolved.status,200);
  assert.equal(resolved.data.status,'resolved');

  const history = await api(
    'GET',audit,moderatorToken
  );

  assert.equal(history.status,200);
  assert.equal(history.data.events.length,3);
  assert.equal(history.data.events[1].to,'triaged');
  assert.equal(history.data.events[2].to,'resolved');

  assert.match(
    history.data.events[2].actorId,
    /^[a-f0-9]{32}$/
  );

  assert.equal(
    (await api('GET',audit,report.viewer)).status,
    401
  );

  const reporterView = await api(
    'GET',`/api/reports/${report.reportId}`,
    report.viewer
  );

  assert.equal(reporterView.status,200);
  assert.equal(reporterView.data.status,'resolved');

  // Stop the room; its report remains available in memory.
  assert.equal(
    (await api(
      'POST',
      `/api/rooms/${report.room}/emergency-stop`,
      report.owner
    )).status,
    200
  );

  assert.equal(
    (await api('GET',audit,moderatorToken)).status,
    200
  );
});
