import { randomBytes } from 'node:crypto';
export const token = () => randomBytes(24).toString('base64url');
export function createStore() {
  const sessions = new Map(); const rooms = new Map();
  function identity(bearer) { return sessions.get(bearer) ?? null; }
  function session(label) {
    if (typeof label !== 'string' || !/^[a-zA-Z0-9 _-]{1,32}$/.test(label)) throw Object.assign(new Error('Invalid demo label'), { status: 400 });
    const secret = token(); const user = { id: token(), label }; sessions.set(secret,user); return { secret, user };
  }
  function room(user) {
    const id = token().slice(0,12);
    const value={id, ownerId:user.id, members:new Map([[user.id,{id:user.id,label:user.label,role:'publisher'}]]), invites:new Map(), peers:new Map()};
    rooms.set(id,value);return value;
  }
  function get(id){const r=rooms.get(id);if(!r)throw Object.assign(new Error('Room not found'),{status:404});return r;}
  function requireMember(r,user){const member=r.members.get(user.id);if(!member)throw Object.assign(new Error('Not a room member'),{status:403});return member;}
  function invite(r,user){if(r.ownerId!==user.id)throw Object.assign(new Error('Owner only'),{status:403}); const code=token().slice(0,16);r.invites.set(code,'viewer');return code;}
  function join(r,user,code){if(r.members.has(user.id))return r.members.get(user.id);const role=r.invites.get(code);if(!role)throw Object.assign(new Error('Invalid or expired invite'),{status:403});r.invites.delete(code);const member={id:user.id,label:user.label,role};r.members.set(user.id,member);return member;}
  function revoke(r,actor,targetId){if(r.ownerId!==actor.id)throw Object.assign(new Error('Owner only'),{status:403});if(targetId===r.ownerId)throw Object.assign(new Error('Cannot revoke owner'),{status:400});if(!r.members.delete(targetId))throw Object.assign(new Error('Member not found'),{status:404});const ws=r.peers.get(targetId);if(ws){try{ws.send(JSON.stringify({type:'revoked'}));ws.close(4003,'Membership revoked');}catch{}}r.peers.delete(targetId);for(const [id,peer] of r.peers)if(peer.readyState===1)peer.send(JSON.stringify({type:'peer-revoked',id:targetId,reason:'membership-revoked'}));}
  return {sessions,rooms,identity,session,room,get,requireMember,invite,join,revoke};
}
