import { WebSocket, WebSocketServer } from 'ws';

// LAB ONLY: forward small JPEG frames. This is NOT WebRTC, an SFU, or encrypted end-to-end.
export function createMediaGateway(store) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 196_608 });
  const sockets = new Map(); // roomId -> Map(userId, ws)
  let seq = 0;
  const key = (roomId) => sockets.get(roomId) ?? new Map();
  const send = (ws, payload) => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 524_288) ws.send(JSON.stringify(payload));
  };
  function revoke(roomId, targetId) {
    const ws = key(roomId).get(targetId);
    if (ws) {
      send(ws, { type: 'revoked', reason: 'membership-revoked' });
      ws.close(4003, 'Revoked');
      key(roomId).delete(targetId);
    }
  }
  wss.on('connection', ws => {
    let room = null;
    let user = null;
    let lastFrameAt = 0;
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(1008, 'Invalid JSON'); }
      if (!user) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || typeof msg.roomId !== 'string') return ws.close(4001, 'Authentication required');
        const identity = store.identity(msg.token);
        if (!identity) return ws.close(4001, 'Unauthorized');
        let target;
        try { target = store.get(msg.roomId); store.requireMember(target, identity); }
        catch { return ws.close(4001, 'Not a member'); }
        user = identity; room = target;
        if (!sockets.has(room.id)) sockets.set(room.id, new Map());
        const current = sockets.get(room.id).get(user.id);
        if (current && current !== ws) current.close(4002, 'Replaced');
        sockets.get(room.id).set(user.id, ws);
        return send(ws, { type: 'ready', id: user.id, role: room.members.get(user.id).role });
      }
      // Authorization checked on EVERY incoming frame, not only at connection time.
      if (!room.members.has(user.id)) return ws.close(4003, 'Revoked');
      if (msg.type !== 'frame') return send(ws, { type: 'error', error: 'Unknown action' });
      if (room.members.get(user.id).role !== 'publisher') return send(ws, { type: 'error', error: 'Publisher only' });
      if (typeof msg.jpeg !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(msg.jpeg) || msg.jpeg.length > 170_000) return send(ws, { type: 'error', error: 'Invalid or oversized frame' });
      const now = Date.now();
      if (now - lastFrameAt < 150) return; // protect local demo from excessive frames
      lastFrameAt = now;
      const payload = { type: 'frame', jpeg: msg.jpeg, seq: ++seq, sentAt: now };
      for (const [memberId, recipient] of key(room.id)) {
        if (memberId === user.id) continue;
        // Recipient membership is verified at delivery time, independently of client behavior.
        if (!room.members.has(memberId) || room.members.get(memberId).role !== 'viewer') continue;
        send(recipient, payload);
      }
    });
    ws.on('close', () => {
      if (room && sockets.get(room.id)?.get(user?.id) === ws) {
        sockets.get(room.id).delete(user.id);
        if (sockets.get(room.id).size === 0) sockets.delete(room.id);
      }
    });
  });
  return { wss, revoke };
}
