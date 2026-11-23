import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

function messages(ws) {
  const backlog=[];const waiting=[];
  ws.on('message', d=>{const m=JSON.parse(String(d));const i=waiting.findIndex(x=>x.match(m));if(i<0)backlog.push(m);else{const [w]=waiting.splice(i,1);clearTimeout(w.timer);w.resolve(m)}});
  return (match,timeout=1200)=>{const i=backlog.findIndex(match);if(i>=0)return Promise.resolve(backlog.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={match,resolve,timer:null};w.timer=setTimeout(()=>{const ix=waiting.indexOf(w);if(ix>=0)waiting.splice(ix,1);reject(Error('Timeout awaiting gateway event'))},timeout);waiting.push(w)})};
}
async function setup(t){
  const app=createApp();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{for(const w of app.wss.clients)w.terminate();for(const w of app.mediaWss.clients)w.terminate();await new Promise(r=>app.mediaWss.close(r));await new Promise(r=>app.wss.close(r));await new Promise(r=>app.server.close(r))});
  const port=app.server.address().port;const api=async(method,path,secret,body)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
  const alice=(await api('POST','/api/sessions',null,{label:'Alice'})).data;const bob=(await api('POST','/api/sessions',null,{label:'Bob'})).data;
  const room=(await api('POST','/api/rooms',alice.secret)).data.roomId;
  const invite=(await api('POST',`/api/rooms/${room}/invites`,alice.secret)).data.invite;
  await api('POST',`/api/rooms/${room}/join`,bob.secret,{invite});
  async function connect(secret){const ws=new WebSocket(`ws://127.0.0.1:${port}/media`,{origin:'http://localhost:5173'});const next=messages(ws);await once(ws,'open');ws.send(JSON.stringify({type:'auth',token:secret,roomId:room}));await next(m=>m.type==='ready');return {ws,next}}
  return {api,room,alice,bob,connect,port};
}
const jpeg='data:image/jpeg;base64,'+Buffer.from('synthetic not valid jpeg bytes (transport test only)').toString('base64');
test('T-05: gateway forwards authorized publisher frame to authorized viewer',async t=>{
 const f=await setup(t);const a=await f.connect(f.alice.secret);const b=await f.connect(f.bob.secret);
 const got=b.next(m=>m.type==='frame');a.ws.send(JSON.stringify({type:'frame',jpeg}));const frame=await got;
 assert.equal(frame.jpeg,jpeg);assert.equal(frame.seq>0,true);
});
test('T-05: revoked receiver gets no further frames even if it ignores notifications',async t=>{
 const f=await setup(t);const a=await f.connect(f.alice.secret);const b=await f.connect(f.bob.secret);
 let frames=0;b.ws.on('message',data=>{if(JSON.parse(String(data)).type==='frame')frames++});
 const initial=b.next(m=>m.type==='frame');a.ws.send(JSON.stringify({type:'frame',jpeg}));await initial;
 const closing=once(b.ws,'close');const r=await f.api('DELETE',`/api/rooms/${f.room}/members/${f.bob.user.id}`,f.alice.secret);assert.equal(r.status,200);
 assert.equal((await closing)[0],4003);
 const before=frames;
 await new Promise(resolve=>setTimeout(resolve,180));a.ws.send(JSON.stringify({type:'frame',jpeg}));
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(frames,before);
 assert.equal((await f.api('GET',`/api/rooms/${f.room}`,f.bob.secret)).status,403);
});
test('T-05: viewer cannot publish through media gateway',async t=>{
 const f=await setup(t);const a=await f.connect(f.alice.secret);const b=await f.connect(f.bob.secret);
 const denied=b.next(m=>m.type==='error');b.ws.send(JSON.stringify({type:'frame',jpeg}));assert.match((await denied).error,/Publisher only/);
});
