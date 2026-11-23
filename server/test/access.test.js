import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
async function fixture(t){const app=createApp();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>{for(const ws of app.wss.clients)ws.terminate();app.wss.close(()=>app.server.close(resolve));}));const port=app.server.address().port;const api=async(method,path,token,body)=>{const res=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()}};return {api,port};}
test('anonymous clients cannot create rooms',async t=>{const {api}=await fixture(t);assert.equal((await api('POST','/api/rooms')).status,401);});
test('membership and role restrictions hold at the API boundary',async t=>{
 const {api}=await fixture(t);const owner=(await api('POST','/api/sessions',null,{label:'Owner'})).data.secret;const viewer=(await api('POST','/api/sessions',null,{label:'Viewer'})).data.secret;const outsider=(await api('POST','/api/sessions',null,{label:'Outsider'})).data.secret;
 const room=(await api('POST','/api/rooms',owner)).data.roomId;
 assert.equal((await api('GET',`/api/rooms/${room}`,outsider)).status,403);
 assert.equal((await api('POST',`/api/rooms/${room}/join`,viewer,{invite:'fake'})).status,403);
 const invite=(await api('POST',`/api/rooms/${room}/invites`,owner)).data.invite;
 assert.equal((await api('POST',`/api/rooms/${room}/join`,viewer,{invite})).data.role,'viewer');
 assert.equal((await api('POST',`/api/rooms/${room}/join`,outsider,{invite})).status,403);
 assert.equal((await api('POST',`/api/rooms/${room}/invites`,viewer)).status,403);
 const m=(await api('GET',`/api/rooms/${room}`,owner)).data.members.find(x=>x.label==='Viewer');
 assert.equal((await api('DELETE',`/api/rooms/${room}/members/${m.id}`,viewer)).status,403);
 assert.equal((await api('DELETE',`/api/rooms/${room}/members/${m.id}`,owner)).status,200);
 assert.equal((await api('GET',`/api/rooms/${room}`,viewer)).status,403);
});
test('viewer cannot send a WebRTC offer through signaling',async t=>{
 const {api,port}=await fixture(t);const owner=(await api('POST','/api/sessions',null,{label:'Owner'})).data.secret;const viewer=(await api('POST','/api/sessions',null,{label:'Viewer'})).data.secret;const room=(await api('POST','/api/rooms',owner)).data.roomId;const invite=(await api('POST',`/api/rooms/${room}/invites`,owner)).data.invite;await api('POST',`/api/rooms/${room}/join`,viewer,{invite});
 const ws=new WebSocket(`ws://127.0.0.1:${port}/signal`,{origin:'http://localhost:5173'});t.after(()=>ws.terminate());await once(ws,'open');ws.send(JSON.stringify({type:'auth',token:viewer,roomId:room}));let [payload]=await once(ws,'message');assert.equal(JSON.parse(String(payload)).role,'viewer');ws.send(JSON.stringify({type:'signal',to:'anyone',data:{type:'offer',sdp:'fake'}}));[payload]=await once(ws,'message');assert.match(JSON.parse(String(payload)).error,/publisher/);
});
