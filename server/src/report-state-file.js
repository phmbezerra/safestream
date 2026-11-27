import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export const REPORT_SCHEMA = 't15-reports-1';
export const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 500;
const ID = /^[A-Za-z0-9_-]{32}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{12}$/;
const MODERATOR_ID = /^[a-f0-9]{32}$/;

const CATEGORY = new Set([
  'harassment', 'coercion', 'privacy', 'other'
]);

const STATUS = new Set([
  'submitted', 'triaged', 'resolved'
]);

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function invalid(message) {
  throw new Error(
    `SafeStream report state invalid: ${message} (refusing to start)`
  );
}

function isObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function keys(value, expected) {
  return isObject(value) &&
    Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));
}

function time(value) {
  if (typeof value !== 'string' || !ISO.test(value)) {
    invalid('timestamp');
  }

  const parsed = Date.parse(value);

  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    invalid('timestamp');
  }

  return parsed;
}

export function emptyReportState() {
  return {
    schemaVersion: REPORT_SCHEMA,
    records: []
  };
}

export function validateReportState(state) {
  if (
    !keys(state, ['schemaVersion', 'records']) ||
    state.schemaVersion !== REPORT_SCHEMA ||
    !Array.isArray(state.records)
  ) {
    invalid('schema');
  }

  if (state.records.length > MAX_RECORDS) {
    invalid('too many records');
  }

  const seen = new Set();

  for (const record of state.records) {
    if (!keys(record, ['report', 'events'])) {
      invalid('record fields');
    }

    const r = record.report;
    const hasIdempotencyHash =
      isObject(r) && Object.hasOwn(r, 'idempotencyHash');

    if (
      !keys(r, [
        'id', 'roomId', 'reporterId', 'category',
        'status', 'createdAt', 'updatedAt', 'expiresAt',
        ...(hasIdempotencyHash ? ['idempotencyHash'] : [])
      ]) ||
      (hasIdempotencyHash &&
       (typeof r.idempotencyHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(r.idempotencyHash))) ||
      typeof r.id !== 'string' || !ID.test(r.id) ||
      typeof r.roomId !== 'string' || !ROOM_ID.test(r.roomId) ||
      typeof r.reporterId !== 'string' || !ID.test(r.reporterId) ||
      !CATEGORY.has(r.category) ||
      !STATUS.has(r.status) ||
      !Number.isSafeInteger(r.expiresAt)
    ) {
      invalid('report fields');
    }

    if (seen.has(r.id)) {
      invalid('duplicate report ID');
    }

    seen.add(r.id);

    const created = time(r.createdAt);
    const updated = time(r.updatedAt);

    if (
      updated < created ||
      r.expiresAt !== created + REPORT_RETENTION_MS
    ) {
      invalid('report times');
    }

    if (
      !Array.isArray(record.events) ||
      record.events.length < 1 ||
      record.events.length > 3
    ) {
      invalid('event count');
    }

    let previous = null;
    let lastTime = created;

    for (let i = 0; i < record.events.length; i++) {
      const e = record.events[i];

      if (!keys(e, [
        'action', 'actorId', 'at', 'from', 'to'
      ])) {
        invalid('event fields');
      }

      const expectedTo = [
        'submitted', 'triaged', 'resolved'
      ][i];

      const expectedAction = i === 0
        ? 'submitted'
        : 'status-transition';

      if (
        e.action !== expectedAction ||
        e.from !== previous ||
        e.to !== expectedTo ||
        typeof e.actorId !== 'string' ||
        (
          i === 0
            ? e.actorId !== r.reporterId
            : !MODERATOR_ID.test(e.actorId)
        )
      ) {
        invalid('event transition');
      }

      const at = time(e.at);

      if (
        at < lastTime ||
        (i === 0 && e.at !== r.createdAt)
      ) {
        invalid('event times');
      }

      lastTime = at;
      previous = e.to;
    }

    if (
      r.status !== previous ||
      r.updatedAt !== record.events.at(-1).at
    ) {
      invalid('report/event mismatch');
    }
  }

  return state;
}

export function readReportState(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('Report file path required');
  }

  let buffer;

  try {
    buffer = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return emptyReportState();
    }

    throw e;
  }

  if (buffer.byteLength > MAX_BYTES) {
    invalid('file too large');
  }

  let data;

  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    invalid('malformed JSON');
  }

  return validateReportState(data);
}

export function writeReportState(file, state) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('Report file path required');
  }

  validateReportState(state);

  const serialized = JSON.stringify(state, null, 2) + '\n';

  if (Buffer.byteLength(serialized) > MAX_BYTES) {
    invalid('file too large');
  }

  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });

  const temporary = file + '.tmp-' +
    randomBytes(8).toString('hex');

  let fd;

  try {
    fd = fs.openSync(temporary, 'wx', 0o600);

    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fd = undefined;

    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }

    try {
      fs.unlinkSync(temporary);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
}
