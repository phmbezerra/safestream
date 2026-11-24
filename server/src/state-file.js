// T-08C: minimal, opt-in, single-process snapshot store for LOCAL LAB ONLY.
// This is not an ACID database or suitable for multiple Node processes.
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_SCHEMA = 't08c-state-1';
const ID = /^[A-Za-z0-9_-]{32}$/;
const ROOM = /^[A-Za-z0-9_-]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9 _-]{1,32}$/;
const MAX_BYTES = 4 * 1024 * 1024;

export function fingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

function object(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function invalid(message) { throw new Error(`SafeStream state file invalid: ${message} (refusing to start)`); }

export function validateSnapshot(s) {
  if (!object(s) || s.schemaVersion !== SNAPSHOT_SCHEMA || !Array.isArray(s.sessions) || !Array.isArray(s.rooms)) invalid('schema');
  const userIds = new Set(), hashes = new Set(), roomIds = new Set();
  if (s.sessions.length > 10000 || s.rooms.length > 10000) invalid('oversized collections');
  for (const item of s.sessions) {
    if (!object(item) || !HASH.test(item.fingerprint) || !object(item.user) || !ID.test(item.user.id) || !LABEL.test(item.user.label)) invalid('session entry');
    if (hashes.has(item.fingerprint) || userIds.has(item.user.id)) invalid('duplicate session');
    hashes.add(item.fingerprint); userIds.add(item.user.id);
  }
  for (const room of s.rooms) {
    if (!object(room) || !ROOM.test(room.id) || !ID.test(room.ownerId) || !Array.isArray(room.members)) invalid('room entry');
    if (roomIds.has(room.id) || room.members.length > 10000) invalid('duplicate/oversized room');
    roomIds.add(room.id);
    const seen = new Set(); let owners = 0;
    for (const m of room.members) {
      if (!object(m) || !ID.test(m.id) || !LABEL.test(m.label) || !['publisher','viewer'].includes(m.role)) invalid('member');
      if (!userIds.has(m.id) || seen.has(m.id)) invalid('orphan or duplicate member');
      seen.add(m.id);
      if (m.id === room.ownerId && m.role === 'publisher') owners++;
      else if (m.role !== 'viewer') invalid('nonowner publisher');
    }
    if (owners !== 1) invalid('missing owner');
  }
  return s;
}

export function readState(file) {
  if (!file) return {schemaVersion: SNAPSHOT_SCHEMA, sessions: [], rooms: []};
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') return {schemaVersion: SNAPSHOT_SCHEMA, sessions: [], rooms: []};
    throw e;
  }
  if (buf.byteLength > MAX_BYTES) invalid('file too large');
  let s;
  try { s = JSON.parse(buf.toString('utf8')); }
  catch { invalid('malformed JSON'); }
  return validateSnapshot(s);
}

export function writeState(file, snapshot) {
  if (!file) return;
  validateSnapshot(snapshot);
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('SafeStream state too large');
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // One process only: use a unique temp file, flush it, and rename over the snapshot.
  // Never expose raw bearer secrets in this file, only SHA-256 fingerprints.
  const temporary = file + '.tmp-' + randomBytes(8).toString('hex');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
