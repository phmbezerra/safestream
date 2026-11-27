import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportingStore } from '../src/reporting.js';

const aliceId = 'A'.repeat(32);
const bobId = 'B'.repeat(32);
const roomId = 'R'.repeat(12);

test('T-15: synthetic report has minimal fields', () => {
  const store = createReportingStore({
    now: () => Date.UTC(2026, 10, 27, 18)
  });

  const report = store.submit({
    roomId,
    reporterId: aliceId,
    category: 'harassment'
  });

  assert.match(report.id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(
    Object.keys(report).sort(),
    [
      'id', 'roomId', 'category',
      'status', 'createdAt', 'updatedAt'
    ].sort()
  );

  assert.equal(report.status, 'submitted');
  assert.equal(
    report.createdAt,
    '2026-11-27T18:00:00.000Z'
  );

  assert.deepEqual(
    store.getForReporter(report.id, aliceId),
    report
  );
});

test('T-15: another reporter cannot read a report', () => {
  const store = createReportingStore();

  const report = store.submit({
    roomId,
    reporterId: aliceId,
    category: 'privacy'
  });

  assert.throws(
    () => store.getForReporter(report.id, bobId),
    error => error.status === 404
  );

  assert.throws(
    () => store.getForReporter('not-an-id', bobId),
    error => error.status === 404
  );
});

test('T-15: rejects raw descriptions and media', () => {
  const store = createReportingStore();

  assert.throws(
    () => store.submit({
      roomId,
      reporterId: aliceId,
      category: 'unknown'
    }),
    error => error.status === 400
  );

  assert.throws(
    () => store.submit({
      roomId,
      reporterId: aliceId,
      category: 'other',
      description: 'private message'
    }),
    error => error.status === 400
  );

  assert.throws(
    () => store.submit({
      roomId,
      reporterId: aliceId,
      category: 'other',
      media: 'data:video/mp4;base64,...'
    }),
    error => error.status === 400
  );
});

test('T-15: retention and capacity limits', () => {
  let clock = Date.UTC(2026, 10, 27, 18);

  const store = createReportingStore({
    now: () => clock,
    maxReports: 1
  });

  const report = store.submit({
    roomId,
    reporterId: aliceId,
    category: 'coercion'
  });

  assert.throws(
    () => store.submit({
      roomId,
      reporterId: aliceId,
      category: 'other'
    }),
    error => error.status === 429
  );

  clock += 7 * 24 * 60 * 60 * 1000;

  assert.throws(
    () => store.getForReporter(report.id, aliceId),
    error => error.status === 404
  );

  assert.equal(
    store.submit({
      roomId,
      reporterId: aliceId,
      category: 'other'
    }).status,
    'submitted'
  );
});
