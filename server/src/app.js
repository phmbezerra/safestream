import http from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore } from './core.js';
import { createMediaGateway } from './media-gateway.js';
import { createReportingStore } from './reporting.js';
import { createModeratorAuth } from './moderator-auth.js';
export function createApp({
 stateFile = null,
 moderatorToken = null,
 reportStateFile = null
} = {}){
 // Never allow both stores to overwrite the same file.
 if(stateFile && reportStateFile &&
    resolve(stateFile).toLowerCase() ===
    resolve(reportStateFile).toLowerCase()){
  throw new Error('Room and report state paths must differ');
 }
 // Persisted reports require recoverable reporter identities.
 if(reportStateFile && !stateFile){
  throw new Error(
   'Report persistence requires session persistence'
  );
 }
 const store=createStore({stateFile});
 const mediaGateway=createMediaGateway(store);
 const reporting=createReportingStore({stateFile:reportStateFile});
 const moderatorAuth=createModeratorAuth({token:moderatorToken});
 // T13 LAN is opt-in; accept only the explicit second development origin.
 const origins=new Set(['http://localhost:5173']);
 const lanOrigin=process.env.SAFESTREAM_LAN_ORIGIN;
 if(lanOrigin)origins.add(lanOrigin);
 function json(res,status,obj){const origin=res.req?.headers?.origin;const headers={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Headers':'Authorization, Content-Type, Idempotency-Key','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Vary':'Origin'};if(origins.has(origin))headers['Access-Control-Allow-Origin']=origin;res.writeHead(status,headers);res.end(JSON.stringify(obj));}
 async function read(req){let data='';for await(const c of req){data+=c;if(data.length>8192)throw Object.assign(new Error('Payload too large'),{status:413});}try{return JSON.parse(data||'{}')}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}}
 const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS')return json(res,200,{});
  try{
   const u=new URL(req.url,'http://localhost');const parts=u.pathname.split('/').filter(Boolean);
   if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,lab:true});
   if(req.method==='POST'&&u.pathname==='/api/sessions')return json(res,201,store.session((await read(req)).label));

   // T-15: administrative authorization is independent
   // from ordinary room sessions and room ownership.
   if(parts[0]==='api'&&parts[1]==='moderation'){
    const actor=moderatorAuth.authenticateHeader(
     req.headers.authorization || ''
    );

    if(!actor)
     return json(res,401,{error:'Unauthorized'});

    if(req.method==='GET'&&
       parts.length===3&&parts[2]==='reports'){
     const offsetText=u.searchParams.get('offset') ?? '0';
     const limitText=u.searchParams.get('limit') ?? '50';

     if(!/^(0|[1-9][0-9]*)$/.test(offsetText)||
        !/^[1-9][0-9]*$/.test(limitText)){
      return json(res,400,{error:'Invalid pagination'});
     }

     return json(res,200,reporting.listForModerator(actor,{
      offset:Number(offsetText),
      limit:Number(limitText)
     }));
    }

    if(parts.length===5&&parts[2]==='reports'){
     const id=parts[3];

     if(req.method==='GET'&&parts[4]==='audit'){
      return json(res,200,{
       reportId:id,
       events:reporting.auditForModerator(id,actor)
      });
     }

     if(req.method==='POST'&&parts[4]==='transitions'){
      const body=await read(req);

      if(!body||typeof body!=='object'||
         Array.isArray(body)||
         Object.keys(body).length!==1||
         !Object.hasOwn(body,'status')){
       throw Object.assign(
        new Error('Only status is accepted'),{status:400}
       );
      }

      return json(res,200,
       reporting.transitionForModerator(id,actor,body.status)
      );
     }
    }

    return json(res,404,{error:'Not found'});
   }

   const header=req.headers.authorization||'';const user=header.startsWith('Bearer ')?store.identity(header.slice(7)):null;
   if(!user)return json(res,401,{error:'Unauthorized'});

   // T-15: only the original reporter may read this report.
   // Report access remains separate from active room membership.
   if(req.method==='GET'&&parts.length===3&&
      parts[0]==='api'&&parts[1]==='reports'){
    return json(res,200,
      reporting.getForReporter(parts[2],user.id));
   }
   if(req.method==='POST'&&u.pathname==='/api/rooms'){const r=store.room(user);return json(res,201,{roomId:r.id,role:'publisher'});}
   if(parts[0]==='api'&&parts[1]==='rooms'&&parts[2]){
    const r=store.get(parts[2]);

    // T-15: derive room and reporter identity on the server.
    if(req.method==='POST'&&parts[3]==='reports'&&parts.length===4){
     store.requireMember(r,user);
     const body=await read(req);

     if(!body||typeof body!=='object'||Array.isArray(body)||
        Object.keys(body).length!==1||
        !Object.hasOwn(body,'category')){
      throw Object.assign(
        new Error('Only category is accepted'),
        {status:400}
      );
     }

     // Authorization must be checked AFTER reading the body.
     // The room may have been stopped or membership revoked.
     const activeRoom=store.get(r.id);
     store.requireMember(activeRoom,user);

     const report=reporting.submit({
      roomId:activeRoom.id,
      reporterId:user.id,
      category:body.category,
      idempotencyKey:req.headers['idempotency-key'] ?? null
     });

     return json(res,201,report);
    }
    if(req.method==='POST'&&parts[3]==='join'){const m=store.join(r,user,(await read(req)).invite);return json(res,200,{roomId:r.id,role:m.role});}
    if(req.method==='POST'&&parts[3]==='invites'){store.requireMember(r,user);return json(res,201,{invite:store.invite(r,user)});}
    if(req.method==='GET'&&parts.length===3){const m=store.requireMember(r,user);return json(res,200,{roomId:r.id,ownerId:r.ownerId,role:m.role,members:[...r.members.values()]});}
    if(req.method==='POST'&&parts[3]==='emergency-stop'&&parts.length===4){
     let result;
     try {
      result=store.emergencyStop(r,user);
     } finally {
      // Close legacy media only if the room was actually invalidated.
      // An unauthorized caller must never trigger this shutdown.
      if(!store.rooms.has(r.id))mediaGateway.stopRoom(r.id);
     }
     return json(res,200,result);
    }
    if(req.method==='DELETE'&&parts[3]==='members'&&parts[4]){store.requireMember(r,user);store.revoke(r,user,parts[4]);mediaGateway.revoke(r.id,parts[4]);return json(res,200,{revoked:true,notice:'Signaling access removed and cooperative peers notified. A modified P2P client may ignore revocation; media access is NOT cryptographically revoked.'});}
   }
   return json(res,404,{error:'Not found'});
  }catch(e){return json(res,e.status||500,{error:e.status?e.message:'Internal error'});}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:8192});
 server.on('upgrade',(req,socket,head)=>{const u=new URL(req.url,'http://localhost');if(!origins.has(req.headers.origin)){socket.destroy();return;}if(u.pathname==='/media'){mediaGateway.wss.handleUpgrade(req,socket,head,ws=>mediaGateway.wss.emit('connection',ws));return;}if(u.pathname!=='/signal'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));});
 wss.on('connection',ws=>{
  let current=null; let uid=null; let authorized=false;
  const fail=(reason)=>{try{ws.send(JSON.stringify({type:'error',error:reason}))}catch{}};
  ws.on('message',buf=>{
   try{
    const msg=JSON.parse(String(buf));
    if(!authorized){
     if(msg.type!=='auth')return ws.close(4001,'Authentication required');
     const user=store.identity(msg.token);if(!user)return ws.close(4001,'Unauthorized');
     let r;try{r=store.get(msg.roomId);store.requireMember(r,user);}catch{return ws.close(4001,'Not a room member');}
     const existing=r.peers.get(user.id);if(existing&&existing!==ws)existing.close(4002,'Replaced session');
     uid=user.id;current=r;authorized=true;r.peers.set(uid,ws);
     ws.send(JSON.stringify({type:'ready',id:uid,role:r.members.get(uid).role,peers:[...r.peers.keys()].filter(id=>id!==uid)}));
     for(const [id,peer] of r.peers)if(id!==uid&&peer.readyState===WebSocket.OPEN)peer.send(JSON.stringify({type:'peer-joined',id:uid}));return;
    }
    if(!current.members.has(uid))return ws.close(4003,'Revoked');
    if(msg.type==='signal'){
     const member=current.members.get(uid);const data=msg.data;
     if(!data||typeof data!=='object'||!['offer','answer','candidate'].includes(data.type))return fail('Invalid signal');
     if(data.type==='offer'&&member.role!=='publisher')return fail('Only publisher can send offers');
     if(typeof msg.to!=='string'||!current.members.has(msg.to))return fail('Invalid recipient');
     const dest=current.peers.get(msg.to);if(dest?.readyState!==WebSocket.OPEN)return fail('Recipient disconnected');
     dest.send(JSON.stringify({type:'signal',from:uid,data}));return;
    }
    fail('Unknown action');
   }catch{fail('Invalid message');}
  });
  ws.on('close',()=>{if(current&&current.peers.get(uid)===ws){current.peers.delete(uid);for(const peer of current.peers.values())if(peer.readyState===WebSocket.OPEN)peer.send(JSON.stringify({type:'peer-left',id:uid}));}});
 });
 return {server,store,wss,mediaWss:mediaGateway.wss};
}
