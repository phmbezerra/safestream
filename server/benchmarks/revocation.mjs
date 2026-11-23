/**
 * SafeStream T-06: repeatable local media-gateway revocation experiment.
 * Requirements: v0.5 server gateway installed; Node 20+; npm dependencies installed.
 * No real people, screens, recordings, or third-party services are involved.
 */
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

const ORIGIN = 'http://localhost:5173';
const TIMEOUT_MS = 3500;
// A valid synthetic 1x1 JPEG (no personal data), transported over JSON/WebSocket.
const FRAME = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}
const round = value => Number(value.toFixed(3));

function createInbox(ws) {
  const messages = [];
  const waiters = [];
  const observedFrames = [];
  let closedAt = null;
  let closedCode = null;
  const closePromise = new Promise(resolve => {
    ws.on('close', (code) => {
      closedAt = performance.now();
      closedCode = code;
      resolve({ at: closedAt, code });
    });
  });
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'frame') observedFrames.push({ seq: msg.seq, at: performance.now() });
    const index = waiters.findIndex(entry => entry.predicate(msg));
    if (index !== -1) {
      const [entry] = waiters.splice(index, 1);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    } else {
      messages.push(msg);
    }
  });
  function next(predicate, timeout = TIMEOUT_MS) {
    const i = messages.findIndex(predicate);
    if (i !== -1) return Promise.resolve(messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve, timer: null };
      entry.timer = setTimeout(() => {
        const j = waiters.indexOf(entry);
        if (j >= 0) waiters.splice(j, 1);
        reject(new Error('Timeout waiting for media WebSocket message'));
      }, timeout);
      waiters.push(entry);
    });
  }
  return {
    next, frames: observedFrames,
    closePromise,
    get closedAt() { return closedAt; },
    get closedCode() { return closedCode; }
  };
}

async function makeSocket(port, token, roomId, sockets) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, { origin: ORIGIN });
  sockets.push(ws);
  const inbox = createInbox(ws); // attach listeners before auth or server responses
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token, roomId }));
  const ready = await inbox.next(m => m.type === 'ready');
  return { ws, inbox, ready };
}

async function checkReconnect(port, token, roomId, sockets) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media`, { origin: ORIGIN });
  sockets.push(ws);
  const inbox = createInbox(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', token, roomId }));
  return withTimeout(inbox.closePromise, 'rejected reconnection');
}

function getApi(port) {
  return async function api(method, url, secret, body) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${url}: ${JSON.stringify(data)}`);
    return data;
  };
}

async function trial(port, runIndex) {
  const sockets = [];
  const api = getApi(port);
  const startedAt = new Date().toISOString();
  try {
    const alice = await api('POST', '/api/sessions', null, { label: 'Alice' });
    const bob = await api('POST', '/api/sessions', null, { label: 'Bob' });
    const carol = await api('POST', '/api/sessions', null, { label: 'Carol' });
    const { roomId } = await api('POST', '/api/rooms', alice.secret);
    for (const viewer of [bob, carol]) {
      const { invite } = await api('POST', `/api/rooms/${roomId}/invites`, alice.secret);
      await api('POST', `/api/rooms/${roomId}/join`, viewer.secret, { invite });
    }

    const publisher = await makeSocket(port, alice.secret, roomId, sockets);
    const revokedViewer = await makeSocket(port, bob.secret, roomId, sockets);
    const controlViewer = await makeSocket(port, carol.secret, roomId, sockets);
    assert.equal(publisher.ready.role, 'publisher');
    assert.equal(revokedViewer.ready.role, 'viewer');
    assert.equal(controlViewer.ready.role, 'viewer');

    const firstForBob = revokedViewer.inbox.next(m => m.type === 'frame');
    const firstForCarol = controlViewer.inbox.next(m => m.type === 'frame');
    publisher.ws.send(JSON.stringify({ type: 'frame', jpeg: FRAME }));
    const [initialBob, initialCarol] = await Promise.all([firstForBob, firstForCarol]);
    assert.equal(initialBob.seq, initialCarol.seq);
    const preCount = revokedViewer.inbox.frames.length;
    assert.equal(preCount, 1);

    // The v0.5 media gateway limits each publisher to 1 frame / 150 ms.
    await sleep(180);
    const t0 = performance.now(); // client-side time when HTTP revocation was initiated
    await api('DELETE', `/api/rooms/${roomId}/members/${bob.user.id}`, alice.secret);
    const acknowledged = performance.now(); // successful HTTP response observed
    const closing = await withTimeout(revokedViewer.inbox.closePromise, 'revoked media socket closing');

    // Bob's JS WebSocket client does NOT react to 'revoked' by closing its own socket.
    // Only the gateway can disconnect it. Carol is the positive control.
    const followupForCarol = controlViewer.inbox.next(m => m.type === 'frame' && m.seq > initialCarol.seq);
    publisher.ws.send(JSON.stringify({ type: 'frame', jpeg: FRAME }));
    const after = await followupForCarol;
    assert.ok(after.seq > initialCarol.seq);
    await sleep(35); // allow pending WebSocket messages to be observed on the client
    const postResponseFrames = revokedViewer.inbox.frames.filter(f => f.at > acknowledged).length;
    const denied = await checkReconnect(port, bob.secret, roomId, sockets);
    const ok = closing.code === 4003 && denied.code === 4001 && postResponseFrames === 0;

    return {
      run: runIndex, startedAt, status: ok ? 'pass' : 'fail',
      clientObserved: {
        revokeRequestToHttpResponseMs: round(acknowledged - t0),
        revokeRequestToSocketCloseMs: round(closing.at - t0),
        httpResponseToSocketCloseMs: round(closing.at - acknowledged)
      },
      framesBeforeRevoke: preCount,
      framesObservedAfterHttpResponse: postResponseFrames,
      controlViewerReceivedAfterRevoke: true,
      revokedSocketCloseCode: closing.code,
      revokedReconnectCloseCode: denied.code,
      // This proves transport closure, NOT frame decoding, SFU security, or that a client can't retain prior images.
      note: ok ? null : 'Unexpected close code, reconnect code, or post-response delivery'
    };
  } finally {
    for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentage) - 1)]; // nearest-rank
}
function stats(values) {
  if (!values.length) return null;
  return { count: values.length, minMs: round(Math.min(...values)), meanMs: round(values.reduce((a,b) => a + b, 0) / values.length), p50Ms: round(percentile(values, .5)), p95Ms: round(percentile(values, .95)), maxMs: round(Math.max(...values)) };
}
function writeMarkdown(report) {
  const { summary: s } = report;
  return `# T-06 — Automated Media Revocation Benchmark\n\n` +
    `**Run started:** ${report.startedAt}  \n**Environment:** ${report.environment.node} on ${report.environment.platform}  \n**Run count:** ${s.total}  \n**Passed:** ${s.passed}  \n**Failed:** ${s.failed}\n\n` +
    `## Observed metrics (client-side, local loopback)\n\n` +
    `| Metric | Min (ms) | Mean (ms) | p50 (ms) | p95 (ms) | Max (ms) |\n|---|---:|---:|---:|---:|---:|\n` +
    `${summaryRow('Request → HTTP success', s.requestToResponse)}\n` +
    `${summaryRow('Request → media WebSocket close', s.requestToClose)}\n\n` +
    `The latency measurements share a **monotonic clock in the benchmark process** and include local HTTP/WebSocket scheduling and transport overhead. They are **not** a server-internal media cutoff latency or end-to-end visual frame-decoding latency. Negative response-to-close values are possible because event ordering is asynchronous.\n\n` +
    `## Controls and criteria\n\n` +
    `- Bob receives a frame before revocation; Bob's client never voluntarily closes on the revocation notice.\n` +
    `- After server acknowledgment, Bob receives no newly observed frame messages.\n` +
    `- Bob's media socket closes with code 4003; a reconnect attempt is rejected with code 4001.\n` +
    `- Carol, who was not revoked, receives a fresh frame **after** Bob is revoked (positive control).\n\n` +
    `## Limitations\n\n` +
    `- This tests a **local JPEG-over-WebSocket gateway**, not WebRTC, an SFU, Discord, or real-world child safety.\n` +
    `- Synthetic test frames only; there is no decoding or persistence of media in the benchmark.\n` +
    `- The results do not bound in-flight/previously buffered media, and cannot prevent external recording.\n` +
    `- Local loopback performance is not representative of WAN latency or load.\n` +
    `- Report all failures and rerun with different loads rather than treating zero failures in ${s.total} runs as absolute safety.\n\n` +
    `## Per-run outcomes\n\n| Run | Result | Request→close (ms) | Frames after response | Carol received | Close codes (Bob / retry) |\n|---|---|---:|---:|---|---|\n` +
    report.results.map(r => `| ${r.run} | ${r.status} | ${r.clientObserved?.revokeRequestToSocketCloseMs ?? '—'} | ${r.framesObservedAfterHttpResponse ?? '—'} | ${r.controlViewerReceivedAfterRevoke ?? '—'} | ${r.revokedSocketCloseCode ?? '—'} / ${r.revokedReconnectCloseCode ?? '—'} |`).join('\n') + '\n';
}
function summaryRow(label, values) {
  return `| ${label} | ${values?.minMs ?? '—'} | ${values?.meanMs ?? '—'} | ${values?.p50Ms ?? '—'} | ${values?.p95Ms ?? '—'} | ${values?.maxMs ?? '—'} |`;
}
export async function runBenchmark({ runs = 20, outputDir = null, quiet = false } = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) throw new Error('runs must be an integer from 1 to 200');
  const app = createApp();
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  const report = {
    schemaVersion: 't06-1', test: 'T-06 gateway revocation',
    startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`, topology: '127.0.0.1 in-process app with real HTTP + WebSocket clients' },
    results: [], summary: null
  };
  try {
    for (let i = 1; i <= runs; i++) {
      try {
        const data = await trial(port, i);
        report.results.push(data);
        if (!quiet) console.log(`[${i}/${runs}] ${data.status.toUpperCase()} — request→close ${data.clientObserved.revokeRequestToSocketCloseMs}ms`);
      } catch (error) {
        report.results.push({ run: i, startedAt: new Date().toISOString(), status: 'fail', error: error?.message || String(error) });
        if (!quiet) console.error(`[${i}/${runs}] FAIL — ${error?.message || error}`);
      }
    }
  } finally {
    for (const ws of app.mediaWss.clients) ws.terminate();
    for (const ws of app.wss.clients) ws.terminate();
    await new Promise(resolve => app.mediaWss.close(resolve));
    await new Promise(resolve => app.wss.close(resolve));
    await new Promise(resolve => app.server.close(resolve));
  }
  const successful = report.results.filter(r => r.status === 'pass');
  report.summary = {
    total: report.results.length,
    passed: successful.length,
    failed: report.results.length - successful.length,
    requestToResponse: stats(successful.map(r => r.clientObserved.revokeRequestToHttpResponseMs)),
    requestToClose: stats(successful.map(r => r.clientObserved.revokeRequestToSocketCloseMs))
  };
  report.completedAt = new Date().toISOString();
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(outputDir, 'latest.md'), writeMarkdown(report));
    const header = ['run','status','request_to_http_ms','request_to_close_ms','post_response_frames','control_received','close_code','reconnect_code','error'].join(',');
    const csv = value => { const str = String(value ?? ''); return /[\",\r\n]/.test(str) ? `\"${str.replaceAll('\"', '\"\"')}\"` : str; };
    const dataRows = report.results.map(r => [r.run, r.status, r.clientObserved?.revokeRequestToHttpResponseMs, r.clientObserved?.revokeRequestToSocketCloseMs, r.framesObservedAfterHttpResponse, r.controlViewerReceivedAfterRevoke, r.revokedSocketCloseCode, r.revokedReconnectCloseCode, r.error ?? ''].map(csv).join(','));
    await fs.writeFile(path.join(outputDir, 'latest.csv'), [header, ...dataRows].join('\n') + '\n');
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const idx = process.argv.indexOf('--runs');
  const n = idx === -1 ? 20 : Number(process.argv[idx + 1]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const outputDir = path.join(root, 'reports', 't06');
  try {
    const report = await runBenchmark({ runs: n, outputDir });
    console.log(`\nT-06: ${report.summary.passed}/${report.summary.total} trials passed; p95 request→close = ${report.summary.requestToClose?.p95Ms ?? 'n/a'} ms`);
    console.log(`Reports: ${path.join(outputDir, 'latest.json')} / latest.csv / latest.md`);
    if (report.summary.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
