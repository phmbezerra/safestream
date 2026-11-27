import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportingStore } from '../src/reporting.js';

const alice = 'A'.repeat(32);
const room = 'R'.repeat(12);

const moderator = {
  id: 'f'.repeat(32),
  role: 'moderator'
};

function submit(store) {
  return store.submit({
    roomId: room,
    reporterId: alice,
    category: 'privacy'
  });
}

test('T-15: moderation methods reject ordinary actors', () => {
  const store = createReportingStore();
  const report = submit(store);

  const viewer = {
    id: alice,
    role: 'viewer'
  };

  assert.throws(
    () => store.listForModerator(viewer),
    error => error.status === 403
  );

  assert.throws(
    () => store.transitionForModerator(
      report.id, viewer, 'triaged'
    ),
    error => error.status === 403
  );

  assert.throws(
    () => store.auditForModerator(report.id, null),
    error => error.status === 403
  );
});

test('T-15: moderation queue is bounded and minimal', () => {
  const store = createReportingStore();

  submit(store);
  submit(store);

  const queue = store.listForModerator(
    moderator, {limit: 1, offset: 0}
  );

  assert.equal(queue.total, 2);
  assert.equal(queue.reports.length, 1);
  assert.equal(queue.limit, 1);
  assert.equal(queue.offset, 0);

  assert.equal(
    Object.hasOwn(queue.reports[0], 'reporterId'),
    false
  );

  assert.throws(
    () => store.listForModerator(
      moderator, {limit: 200}
    ),
    error => error.status === 400
  );
});

test('T-15: status transitions produce an audit trail', () => {
  let clock = Date.UTC(2026, 10, 27, 18);

  const store = createReportingStore({
    now: () => clock
  });

  const report = submit(store);

  const initial = store.auditForModerator(
    report.id, moderator
  );

  assert.equal(initial.length, 1);
  assert.equal(initial[0].action, 'submitted');
  assert.equal(initial[0].to, 'submitted');

  // Returned events must not expose mutable storage.
  initial[0].action = 'forged';

  assert.equal(
    store.auditForModerator(
      report.id, moderator
    )[0].action,
    'submitted'
  );

  clock += 1000;

  const triaged = store.transitionForModerator(
    report.id, moderator, 'triaged'
  );

  assert.equal(triaged.status, 'triaged');

  clock += 1000;

  const resolved = store.transitionForModerator(
    report.id, moderator, 'resolved'
  );

  assert.equal(resolved.status, 'resolved');

  const history = store.auditForModerator(
    report.id, moderator
  );

  assert.equal(history.length, 3);
  assert.equal(history[1].from, 'submitted');
  assert.equal(history[1].to, 'triaged');
  assert.equal(history[2].from, 'triaged');
  assert.equal(history[2].to, 'resolved');
  assert.equal(history[2].actorId, moderator.id);

  assert.equal(
    store.getForReporter(report.id, alice).status,
    'resolved'
  );
});

test('T-15: invalid transitions and expired audit denied', () => {
  let clock = Date.UTC(2026, 10, 27, 18);

  const store = createReportingStore({
    now: () => clock
  });

  const report = submit(store);

  assert.throws(
    () => store.transitionForModerator(
      report.id, moderator, 'resolved'
    ),
    error => error.status === 409
  );

  assert.throws(
    () => store.transitionForModerator(
      report.id, moderator, 'reopened'
    ),
    error => error.status === 400
  );

  clock += 7 * 24 * 60 * 60 * 1000;

  assert.equal(
    store.listForModerator(moderator).total,
    0
  );

  assert.throws(
    () => store.auditForModerator(
      report.id, moderator
    ),
    error => error.status === 404
  );
});
