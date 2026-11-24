import { randomBytes } from 'node:crypto';
import { fingerprint, readState, writeState, SNAPSHOT_SCHEMA } from './state-file.js';

export const token = () => randomBytes(24).toString('base64url');

// The stateFile is OPT-IN and scoped to one local Node process.
// Invitations and active WebSockets are intentionally never persisted.
export function createStore({ stateFile = null } = {}) {
  const data = readState(stateFile);
  const sessions = new Map(data.sessions.map(s => [s.fingerprint, s.user]));
  const rooms = new Map(data.rooms.map(r => [r.id, {
    id: r.id, ownerId: r.ownerId,
    members: new Map(r.members.map(m => [m.id, m])),
    invites: new Map(), peers: new Map()
  }]));

  function snapshot() {
    return {
      schemaVersion: SNAPSHOT_SCHEMA,
      sessions: [...sessions].map(([digest, user]) => ({fingerprint: digest, user: {...user}})),
      rooms: [...rooms.values()].map(r => ({id: r.id, ownerId: r.ownerId,
        members: [...r.members.values()].map(m => ({...m}))}))
    };
  }
  // Write the intended next snapshot BEFORE mutating live authorization state.
  // A failed write returns 500, with NO success response or revocation notification.
  function durable(modify) {
    if (!stateFile) return;
    const next = snapshot();
    modify(next);
    writeState(stateFile, next);
  }
  function identity(bearer) {
    if (typeof bearer !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(bearer)) return null;
    return sessions.get(fingerprint(bearer)) ?? null;
  }
  function session(label) {
    if (typeof label !== 'string' || !/^[a-zA-Z0-9 _-]{1,32}$/.test(label))
      throw Object.assign(new Error('Invalid demo label'), {status:400});
    let secret, digest, user;
    do {
      secret = token(); digest = fingerprint(secret);
      user = {id: token(), label};
    } while (sessions.has(digest) || [...sessions.values()].some(u => u.id === user.id));
    durable(next => next.sessions.push({fingerprint: digest, user}));
    sessions.set(digest, user);
    return {secret, user};
  }
  function room(user) {
    let id;
    do { id = token().slice(0, 12); } while (rooms.has(id));
    const member = {id:user.id, label:user.label, role:'publisher'};
    const value = {id, ownerId:user.id, members:new Map([[user.id, member]]), invites:new Map(), peers:new Map()};
    durable(next => next.rooms.push({id, ownerId:user.id, members:[member]}));
    rooms.set(id, value);
    return value;
  }
  function get(id) {
    const r = rooms.get(id);
    if (!r) throw Object.assign(new Error('Room not found'), {status:404});
    return r;
  }
  function requireMember(r, user) {
    const member = r.members.get(user.id);
    if (!member) throw Object.assign(new Error('Not a room member'), {status:403});
    return member;
  }
  function invite(r, user) {
    if (r.ownerId !== user.id) throw Object.assign(new Error('Owner only'), {status:403});
    const code = token().slice(0,16);
    r.invites.set(code, 'viewer');
    return code;
  }
  function join(r, user, code) {
    if (r.members.has(user.id)) return r.members.get(user.id);
    const role = r.invites.get(code);
    if (!role) throw Object.assign(new Error('Invalid or expired invite'), {status:403});
    const member = {id:user.id, label:user.label, role};
    durable(next => {
      const match = next.rooms.find(s => s.id === r.id);
      if (!match) throw new Error('Room missing from durable state');
      match.members.push(member);
    });
    r.invites.delete(code);
    r.members.set(user.id, member);
    return member;
  }
  function revoke(r, actor, targetId) {
    if (r.ownerId !== actor.id) throw Object.assign(new Error('Owner only'), {status:403});
    if (targetId === r.ownerId) throw Object.assign(new Error('Cannot revoke owner'), {status:400});
    if (!r.members.has(targetId)) throw Object.assign(new Error('Member not found'), {status:404});
    durable(next => {
      const match = next.rooms.find(s => s.id === r.id);
      if (!match) throw new Error('Room missing from durable state');
      match.members = match.members.filter(m => m.id !== targetId);
    });
    // Only after durable success may any caller report revocation or notify peers.
    r.members.delete(targetId);
    const ws = r.peers.get(targetId);
    if (ws) { try { ws.send(JSON.stringify({type:'revoked'})); ws.close(4003,'Membership revoked'); } catch {} }
    r.peers.delete(targetId);
    for (const [id, peer] of r.peers)
      if (peer.readyState === 1) peer.send(JSON.stringify({type:'peer-revoked',id:targetId,reason:'membership-revoked'}));
  }
  return {sessions, rooms, identity, session, room, get, requireMember, invite, join, revoke};
}
