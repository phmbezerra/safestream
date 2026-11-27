import { randomBytes, createHash } from 'node:crypto';
import {
  REPORT_SCHEMA,
  readReportState,
  writeReportState
} from './report-state-file.js';

const CATEGORIES = new Set([
  'harassment',
  'coercion',
  'privacy',
  'other'
]);

const INPUT_KEYS = new Set([
  'roomId',
  'reporterId',
  'category',
  'idempotencyKey'
]);

const ROOM_ID = /^[A-Za-z0-9_-]{12}$/;
const USER_ID = /^[A-Za-z0-9_-]{32}$/;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function publicView(report) {
  const {
    id, roomId, category,
    status, createdAt, updatedAt
  } = report;

  return {
    id, roomId, category,
    status, createdAt, updatedAt
  };
}

// T-15 phase 1: isolated in-memory domain model.
// HTTP authorization and durable storage are separate phases.
export function createReportingStore({
  now = () => Date.now(),
  maxReports = 500,
  stateFile = null
} = {}) {
  const loaded = stateFile ? readReportState(stateFile) : null;
  const records = loaded?.records ?? [];

  const reports = new Map(
    records.map(({report}) => [report.id, report])
  );

  const audit = new Map(
    records.map(({report, events}) => [report.id, events])
  );

  // Prepare and persist the NEXT state before changing memory.
  function persist(nextReports, nextAudit) {
    if (!stateFile) return;

    writeReportState(stateFile, {
      schemaVersion: REPORT_SCHEMA,
      records: [...nextReports.values()].map(report => ({
        report: {...report},
        events: (nextAudit.get(report.id) ?? []).map(
          event => ({...event})
        )
      }))
    });
  }

  function purgeExpired() {
    const timestamp = now();

    const expired = [...reports]
      .filter(([, report]) => timestamp >= report.expiresAt)
      .map(([id]) => id);

    if (!expired.length) return;

    const nextReports = new Map(reports);
    const nextAudit = new Map(audit);

    for (const id of expired) {
      nextReports.delete(id);
      nextAudit.delete(id);
    }

    // If disk cleanup fails, memory remains unchanged.
    persist(nextReports, nextAudit);

    for (const id of expired) {
      reports.delete(id);
      audit.delete(id);
    }
  }

  function submit(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        key => !INPUT_KEYS.has(key)
      )
    ) {
      fail(400, 'Invalid report fields');
    }

    const {
      roomId,
      reporterId,
      category,
      idempotencyKey = null
    } = input;

    if (
      !ROOM_ID.test(roomId) ||
      !USER_ID.test(reporterId) ||
      !CATEGORIES.has(category) ||
      (
        idempotencyKey !== null &&
        (
          typeof idempotencyKey !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(idempotencyKey) ||
          Buffer.from(idempotencyKey, 'base64url').length !== 32 ||
          Buffer.from(idempotencyKey, 'base64url')
            .toString('base64url') !== idempotencyKey
        )
      )
    ) {
      fail(400, 'Invalid report fields');
    }

    purgeExpired();

    const idempotencyHash = idempotencyKey === null
      ? null
      : createHash('sha256')
        .update(JSON.stringify([
          'safestream-t15-idempotency-v1',
          reporterId,
          roomId,
          idempotencyKey
        ]))
        .digest('hex');

    if (idempotencyHash) {
      for (const existing of reports.values()) {
        if (existing.idempotencyHash !== idempotencyHash) {
          continue;
        }

        if (
          existing.reporterId !== reporterId ||
          existing.roomId !== roomId ||
          existing.category !== category
        ) {
          fail(409, 'Idempotency key conflict');
        }

        return publicView(existing);
      }
    }

    if (reports.size >= maxReports) {
      fail(429, 'Report capacity reached');
    }

    const createdMs = now();
    const at = new Date(createdMs).toISOString();
    let id;
    do {
      id = randomBytes(24).toString('base64url');
    } while (reports.has(id));

    const report = {
      id,
      roomId,
      reporterId,
      category,
      status: 'submitted',
      createdAt: at,
      updatedAt: at,
      expiresAt: createdMs + RETENTION_MS
    };

    if (idempotencyHash) {
      report.idempotencyHash = idempotencyHash;
    }

    const events = [{
      action: 'submitted',
      actorId: reporterId,
      at,
      from: null,
      to: 'submitted'
    }];

    const nextReports = new Map(reports);
    const nextAudit = new Map(audit);

    nextReports.set(id, report);
    nextAudit.set(id, events);

    // No success acknowledgement before persistence.
    persist(nextReports, nextAudit);

    reports.set(id, report);
    audit.set(id, events);

    return publicView(report);
  }

  function getForReporter(id, reporterId) {
    purgeExpired();

    const report = reports.get(id);

    if (!report || report.reporterId !== reporterId) {
      fail(404, 'Report not found');
    }

    return publicView(report);
  }


  // The HTTP handler must authenticate the moderator token
  // before constructing the actor object.
  function requireModerator(actor) {
    if (
      !actor ||
      actor.role !== 'moderator' ||
      typeof actor.id !== 'string' ||
      !/^[a-f0-9]{32}$/.test(actor.id)
    ) {
      fail(403, 'Moderator required');
    }
  }

  function listForModerator(
    actor,
    { offset = 0, limit = 50 } = {}
  ) {
    requireModerator(actor);

    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      fail(400, 'Invalid pagination');
    }

    purgeExpired();

    const ordered = [...reports.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
    );

    return {
      total: ordered.length,
      offset,
      limit,
      reports: ordered
        .slice(offset, offset + limit)
        .map(publicView)
    };
  }

  function transitionForModerator(
    id,
    actor,
    nextStatus
  ) {
    requireModerator(actor);
    purgeExpired();

    const report = reports.get(id);

    if (!report) {
      fail(404, 'Report not found');
    }

    if (
      nextStatus !== 'triaged' &&
      nextStatus !== 'resolved'
    ) {
      fail(400, 'Invalid status');
    }

    const expectedNext = {
      submitted: 'triaged',
      triaged: 'resolved'
    }[report.status];

    if (nextStatus !== expectedNext) {
      fail(409, 'Invalid status transition');
    }

    const at = new Date(now()).toISOString();
    const previous = report.status;

    const updatedReport = {
      ...report,
      status: nextStatus,
      updatedAt: at
    };

    const updatedEvents = [
      ...audit.get(id),
      {
        action: 'status-transition',
        actorId: actor.id,
        at,
        from: previous,
        to: nextStatus
      }
    ];

    const nextReports = new Map(reports);
    const nextAudit = new Map(audit);

    nextReports.set(id, updatedReport);
    nextAudit.set(id, updatedEvents);

    // Failed disk writes must not change the live status.
    persist(nextReports, nextAudit);

    reports.set(id, updatedReport);
    audit.set(id, updatedEvents);

    return publicView(updatedReport);
  }

  function auditForModerator(id, actor) {
    requireModerator(actor);
    purgeExpired();

    if (!reports.has(id)) {
      fail(404, 'Report not found');
    }

    return audit.get(id).map(
      event => ({ ...event })
    );
  }

  // Remove expired persisted records before serving requests.
  // Failure to persist cleanup aborts initialization.
  purgeExpired();

  return {
    submit,
    getForReporter,
    listForModerator,
    transitionForModerator,
    auditForModerator
  };
}
