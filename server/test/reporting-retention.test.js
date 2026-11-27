import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReportingStore } from '../src/reporting.js';
import {
  readReportState,
  REPORT_RETENTION_MS
} from '../src/report-state-file.js';

function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t15-retention-')
  );

  t.after(() => {
    fs.rmSync(dir, {recursive:true, force:true});
  });

  return path.join(dir, 'reports.json');
}

function submit(store) {
  return store.submit({
    roomId: 'R'.repeat(12),
    reporterId: 'A'.repeat(32),
    category: 'privacy'
  });
}

test('T-15 retention: expired reports removed on startup', t => {
  const file = fixture(t);
  let clock = Date.UTC(2026, 10, 27, 18);

  const first = createReportingStore({
    stateFile:file,
    now:() => clock
  });

  const report = submit(first);

  assert.equal(
    readReportState(file).records.length,
    1
  );

  clock += REPORT_RETENTION_MS;

  // Simulate restarting the backend after expiry.
  const restarted = createReportingStore({
    stateFile:file,
    now:() => clock
  });

  assert.equal(
    readReportState(file).records.length,
    0
  );

  assert.throws(
    () => restarted.getForReporter(
      report.id, 'A'.repeat(32)
    ),
    error => error.status === 404
  );
});

test('T-15 retention: active reports survive startup', t => {
  const file = fixture(t);
  let clock = Date.UTC(2026, 10, 27, 18);

  const first = createReportingStore({
    stateFile:file,
    now:() => clock
  });

  const report = submit(first);

  // One millisecond before expiry.
  clock += REPORT_RETENTION_MS - 1;

  const restarted = createReportingStore({
    stateFile:file,
    now:() => clock
  });

  assert.equal(
    readReportState(file).records.length,
    1
  );

  assert.equal(
    restarted.getForReporter(
      report.id, 'A'.repeat(32)
    ).status,
    'submitted'
  );
});
