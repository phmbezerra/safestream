import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../benchmarks/revocation.mjs';

test('T-06: benchmark performs repeated real-transport revocation trials with a positive control', async () => {
  const report = await runBenchmark({ runs: 2, quiet: true });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 2, JSON.stringify(report.results));
  for (const row of report.results) {
    assert.equal(row.framesBeforeRevoke, 1);
    assert.equal(row.framesObservedAfterHttpResponse, 0);
    assert.equal(row.controlViewerReceivedAfterRevoke, true);
    assert.equal(row.revokedSocketCloseCode, 4003);
    assert.equal(row.revokedReconnectCloseCode, 4001);
    assert.ok(Number.isFinite(row.clientObserved.revokeRequestToSocketCloseMs));
  }
  assert.ok(report.summary.requestToClose.p95Ms >= 0);
});
