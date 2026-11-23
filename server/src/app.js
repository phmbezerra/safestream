import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore } from './core.js';
export function createApp(){
 const store=createStore();
 function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'http://localhost:5173','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'});res.end(JSON.stringify(obj));}
 async function read(req){let data='';for await(const c of req){data+=c;if(data.length>8192)throw Object.assign(new Error('Payload too large'),{status:413});}try{return JSON.parse(data||'{}')}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}}
 const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS')return json(res,200,{});
  try{
   const u=new URL(req.url,'http://localhost');const parts=u.pathname.split('/').filter(Boolean);
   if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,lab:true});
   if(req.method==='POST'&&u.pathname==='/api/sessions')return json(res,201,store.session((await read(req)).label));
   const header=req.headers.authorization||'';const user=header.startsWith('Bearer ')?store.identity(header.slice(7)):null;
   if(!user)return json(res,401,{error:'Unauthorized'});
   if(req.method==='POST'&&u.pathname==='/api/rooms'){const r=store.room(user);return json(res,201,{roomId:r.id,role:'publisher'});}
   if(parts[0]==='api'&&parts[1]==='rooms'&&parts[2]){
    const r=store.get(parts[2]);
    if(req.method==='POST'&&parts[3]==='join'){const m=store.join(r,user,(await read(req)).invite);return json(res,200,{roomId:r.id,role:m.role});}
    if(req.method==='POST'&&parts[3]==='invites'){store.requireMember(r,user);return json(res,201,{invite:store.invite(r,user)});}
    if(req.method==='GET'&&parts.length===3){const m=store.requireMember(r,user);return json(res,200,{roomId:r.id,ownerId:r.ownerId,role:m.role,members:[...r.members.values()]});}
    if(req.method==='DELETE'&&parts[3]==='members'&&parts[4]){store.requireMember(r,user);store.revoke(r,user,parts[4]);return json(res,200,{revoked:true,notice:'Existing P2P media connections are NOT cryptographically revoked.'});}
   }
   return json(res,404,{error:'Not found'});
  }catch(e){return json(res,e.status||500,{error:e.status?e.message:'Internal error'});}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:8192});
 server.on('upgrade',(req,socket,head)=>{const u=new URL(req.url,'http://localhost');if(u.pathname!=='/signal'||req.headers.origin!=='http://localhost:5173'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));});
 wss.on('connection',ws=>{
  let current=null; let uid=null; let authorized=false;
  const fail=(reason)=>{try{ws.send(JSON.stringify({type:'error',error:reason}))}catch{}};
  ws.on('message',buf=>{
   try{
    const msg=JSON.parse(String(buf));
    if(!authorized){
     if(msg.type!=='auth')return ws.close(4001,'Authentication required');
     const user=store.identity(msg.token);if(!user)return ws.close(4001,'Unauthorized');
     const r=store.get(msg.roomId);store.requireMember(r,user);
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
 return {server,store,wss};
}
