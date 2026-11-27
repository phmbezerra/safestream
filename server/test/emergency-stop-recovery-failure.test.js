import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createStore } from '../src/core.js';

test('T-14: failed recovery cleanup refuses startup', t => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'safestream-t14-recovery-')
  );

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = path.join(dir, 'state.json');
  const original = createStore({ stateFile: file });
  const alice = original.session('Alice');
  const room = original.room(alice.user);

  const oldSnapshot = fs.readFileSync(file, 'utf8');
  const originalRename = fs.renameSync;
  let failedCleanupAttempted = false;

  try {
    // Simulate a failed atomic commit, without changing
    // any real Windows permissions.
    fs.renameSync = function(source, destination) {
      if (path.resolve(destination) === path.resolve(file)) {
        failedCleanupAttempted = true;

        const error = new Error(
          'Simulated storage permission failure'
        );
        error.code = 'EACCES';
        throw error;
      }

      return originalRename(source, destination);
    };

    // Update the fs bindings used by state-file.js.
    syncBuiltinESMExports();

    assert.throws(
      () => createStore({ stateFile: file }),
      error => error.code === 'EACCES'
    );

    assert.equal(failedCleanupAttempted, true);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      oldSnapshot
    );

  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }

  // Storage is working again. Restart must remove
  // old room grants before returning a usable store.
  const recovered = createStore({ stateFile: file });

  assert.equal(
    recovered.identity(alice.secret).id,
    alice.user.id
  );

  assert.throws(
    () => recovered.get(room.id),
    /Room not found/
  );

  const snapshot = JSON.parse(
    fs.readFileSync(file, 'utf8')
  );

  assert.deepEqual(snapshot.rooms, []);
});
