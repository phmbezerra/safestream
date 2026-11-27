import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  REPORT_SCHEMA,
  REPORT_RETENTION_MS,
  emptyReportState,
  readReportState,
  writeReportState
} from '../src/report-state-file.js';

function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t15-')
  );

  t.after(() => {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  });

  return path.join(dir, 'reports.json');
}

function snapshot() {
  const createdAt = '2026-11-27T18:00:00.000Z';
  const updatedAt = '2026-11-27T18:00:02.000Z';
  const reporterId = 'A'.repeat(32);

  return {
    schemaVersion: REPORT_SCHEMA,
    records: [{
      report: {
        id: 'B'.repeat(32),
        roomId: 'R'.repeat(12),
        reporterId,
        category: 'privacy',
        status: 'resolved',
        createdAt,
        updatedAt,
        expiresAt:
          Date.parse(createdAt) + REPORT_RETENTION_MS
      },
      events: [
        {
          action: 'submitted',
          actorId: reporterId,
          at: createdAt,
          from: null,
          to: 'submitted'
        },
        {
          action: 'status-transition',
          actorId: 'f'.repeat(32),
          at: '2026-11-27T18:00:01.000Z',
          from: 'submitted',
          to: 'triaged'
        },
        {
          action: 'status-transition',
          actorId: 'f'.repeat(32),
          at: updatedAt,
          from: 'triaged',
          to: 'resolved'
        }
      ]
    }]
  };
}

test('T-15 storage: missing file starts empty', t => {
  const file = fixture(t);

  assert.deepEqual(
    readReportState(file),
    emptyReportState()
  );
});

test('T-15 storage: valid reports and audit survive restart', t => {
  const file = fixture(t);
  const data = snapshot();

  writeReportState(file, data);

  assert.deepEqual(
    readReportState(file),
    data
  );
});

test('T-15 storage: rejects additional private fields', t => {
  const file = fixture(t);
  const data = snapshot();

  data.records[0].report.description =
    'raw private message';

  assert.throws(
    () => writeReportState(file, data),
    /report fields/
  );

  assert.equal(fs.existsSync(file), false);
});

test('T-15 storage: forged audit rejected on recovery', t => {
  const file = fixture(t);
  const data = snapshot();

  data.records[0].events[1].from = 'resolved';

  fs.writeFileSync(
    file,
    JSON.stringify(data),
    'utf8'
  );

  assert.throws(
    () => readReportState(file),
    /event transition/
  );
});

test('T-15 storage: corrupted JSON refuses recovery', t => {
  const file = fixture(t);

  fs.writeFileSync(file, '{broken', 'utf8');

  assert.throws(
    () => readReportState(file),
    /malformed JSON/
  );
});
