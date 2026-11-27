import {
  createHash,
  timingSafeEqual
} from 'node:crypto';

function digest(secret) {
  return createHash('sha256')
    .update(secret, 'utf8')
    .digest();
}

// T-15: a single, separately provisioned LAB credential.
// This is not a production moderator identity system.
export function createModeratorAuth({ token = null } = {}) {
  if (token === null) {
    return {
      enabled: false,
      authenticateHeader: () => null
    };
  }

  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(token)
  ) {
    throw new Error(
      'Invalid moderator configuration: ' +
      'expected a high-entropy base64url token'
    );
  }

  const expected = digest(token);

  // Pseudonymous ID for future audit events.
  // The original credential is never returned.
  const actorId = expected
    .toString('hex')
    .slice(0, 32);

  function authenticateHeader(header) {
    if (typeof header !== 'string') {
      return null;
    }

    const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(
      header
    );

    if (!match) {
      return null;
    }

    const candidate = digest(match[1]);

    if (!timingSafeEqual(candidate, expected)) {
      return null;
    }

    return {
      id: actorId,
      role: 'moderator'
    };
  }

  return {
    enabled: true,
    authenticateHeader
  };
}
