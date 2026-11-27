import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createModeratorAuth } from '../src/moderator-auth.js';

const secret = () =>
  randomBytes(32).toString('base64url');

test('T-15: moderation disabled by default', () => {
  const auth = createModeratorAuth();

  assert.equal(auth.enabled, false);
  assert.equal(
    auth.authenticateHeader(`Bearer ${secret()}`),
    null
  );
});

test('T-15: malformed moderator configuration rejected', () => {
  for (const token of [
    '',
    'admin',
    'Moderator',
    'short-secret',
    'A'.repeat(200)
  ]) {
    assert.throws(
      () => createModeratorAuth({ token }),
      /Invalid moderator configuration/
    );
  }
});

test('T-15: only provisioned token authenticates moderator', () => {
  const moderatorToken = secret();
  const userToken = secret();

  const auth = createModeratorAuth({
    token: moderatorToken
  });

  assert.equal(auth.enabled, true);

  const moderator = auth.authenticateHeader(
    `Bearer ${moderatorToken}`
  );

  assert.equal(moderator.role, 'moderator');
  assert.match(moderator.id, /^[a-f0-9]{32}$/);

  assert.equal(
    auth.authenticateHeader(`Bearer ${userToken}`),
    null
  );

  assert.equal(
    auth.authenticateHeader('Bearer Moderator'),
    null
  );

  assert.equal(
    auth.authenticateHeader(null),
    null
  );

  assert.equal(
    JSON.stringify(auth).includes(moderatorToken),
    false
  );
});
