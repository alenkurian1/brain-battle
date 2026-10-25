const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const QB=require('./questions');
const PORT=+process.env.PORT||3000, QN=+process.env.QUESTIONS_PER_MATCH||8,
  QT=+process.env.QUESTION_SECONDS||15, RT=+process.env.REVEAL_SECONDS||5,
  MAXP=8, ROOM_TTL=10*60e3, LOBBY_GRACE=45e3;
const AV=['🦊','🐼','🐸','🦄','🐙','🦖','🐧','🦁'];
const rooms=new Map();
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a};
const newCode=()=>{const L='ABCDEFGHJKLMNPQRSTUVWXYZ';let c;do{c=Array.from({length:4},()=>L[crypto.randomInt(L.length)]).join('')}while(rooms.has(c));return c};
const html=fs.readFileSync(path.join(__dirname,'public/index.html'));
const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.end('ok');return}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
});
const wss=new WebSocketServer({server,maxPayload:2048});

function view(room,me){
  const ps=[...room.players.values()];
  const r={code:room.code,phase:room.phase,host:room.hostId,
    players:ps.map(p=>({id:p.id,name:p.name,av:p.av,score:p.score,ready:p.ready,on:!!p.ws,done:!!p.answer}))
      .sort((a,b)=>b.score-a.score)};
  if(room.phase==='question'||room.phase==='reveal'){
    const q=room.qs[room.qi];
    r.q={i:room.qi+1,n:room.qs.length,text:q.text,opts:q.opts,cat:q.cat,endsAt:room.endsAt};
    r.mine=me.answer?{i:me.answer.i}:null;
    if(room.phase==='reveal'){
      r.correct=q.a;
      r.mine=me.answer?{i:me.answer.i,pts:me.answer.pts}:{i:-1,pts:0};
      r.picks=ps.map(p=>({id:p.id,i:p.answer?p.answer.i:-1,pts:p.answer?p.answer.pts:0}));
    }
  }
  return r;
}
function broadcast(room){
  for(const p of room.players.values())
    if(p.ws&&p.ws.readyState===1)p.ws.send(JSON.stringify({t:'state',now:Date.now(),you:p.id,room:view(room,p)}));
}
const err=(ws,m)=>ws.send(JSON.stringify({t:'error',msg:m}));
function startMatch(room){
  clearTimeout(room.timer);
  room.qs=shuffle(QB).slice(0,QN).map(([text,o,a,cat])=>{
    const idx=shuffle([0,1,2,3]);return{text,cat,opts:idx.map(i=>o[i]),a:idx.indexOf(a)}});
  for(const p of room.players.values()){p.score=0;p.ready=false;p.answer=null}
  room.qi=-1;nextQ(room);
}
function nextQ(room){
  room.qi++;
  if(room.qi>=room.qs.length){room.phase='final';room.endsAt=0;broadcast(room);return}
  for(const p of room.players.values())p.answer=null;
  room.phase='question';room.endsAt=Date.now()+QT*1000;
  room.timer=setTimeout(()=>closeQ(room),QT*1000+50);
  broadcast(room);
}
function closeQ(room){
  if(room.phase!=='question')return;
  clearTimeout(room.timer);room.phase='reveal';room.endsAt=Date.now()+RT*1000;
  room.timer=setTimeout(()=>nextQ(room),RT*1000);
  broadcast(room);
}
function dropHost(room){
  const cur=room.players.get(room.hostId);
  if(cur&&cur.ws)return;
  const next=[...room.players.values()].find(p=>p.ws);
  if(next)room.hostId=next.id;
}
function handle(ws,m){
  if(m.t==='create'||m.t==='join'){
    if(ws.pid)return;
    const name=String(m.name||'').trim().slice(0,16);
    let room,p;
    if(m.t==='create'){
      if(!name)return err(ws,'Enter a nickname');
      room={code:newCode(),hostId:null,players:new Map(),phase:'lobby',qs:[],qi:-1,endsAt:0,timer:null};
      rooms.set(room.code,room);
    }else{
      room=rooms.get(String(m.code||'').toUpperCase().trim());
      if(!room)return err(ws,'Room not found. Check the code.');
      p=m.id&&room.players.get(m.id);
      if(!p){
        if(!name)return err(ws,'Enter a nickname');
        if(room.phase!=='lobby'&&room.phase!=='final')return err(ws,'Match already in progress');
        if(room.players.size>=MAXP)return err(ws,'Room is full (8 players max)');
      }
    }
    if(!p){
      const used=new Set([...room.players.values()].map(x=>x.av));
      p={id:crypto.randomBytes(8).toString('hex'),name,av:AV.find(a=>!used.has(a))||AV[0],score:0,ready:false,answer:null,ws:null};
      room.players.set(p.id,p);
      if(!room.hostId)room.hostId=p.id;
    }
    if(p.ws&&p.ws!==ws)try{p.ws.close()}catch{}
    p.ws=ws;p.dc=0;ws.pid=p.id;ws.room=room;room.emptyAt=0;
    dropHost(room);
    ws.send(JSON.stringify({t:'joined',id:p.id,code:room.code}));
    return broadcast(room);
  }
  const room=ws.room,p=room&&room.players.get(ws.pid);
  if(!p)return;
  if(m.t==='ready'&&room.phase==='lobby'){p.ready=!p.ready;broadcast(room)}
  else if(m.t==='start'){
    if(room.hostId!==p.id)return err(ws,'Only the host can start');
    if(room.phase!=='lobby')return;
    if([...room.players.values()].filter(x=>x.ws).length<2)return err(ws,'Need at least 2 players');
    startMatch(room);
  }else if(m.t==='rematch'){
    if(room.hostId!==p.id||room.phase!=='final')return;
    room.phase='lobby';room.qs=[];room.qi=-1;
    for(const x of room.players.values()){x.score=0;x.ready=false;x.answer=null}
    broadcast(room);
  }else if(m.t==='answer'){
    if(room.phase!=='question'||p.answer)return;           // one answer only
    const i=m.i;if(!Number.isInteger(i)||i<0||i>3)return;
    const now=Date.now();if(now>room.endsAt)return;
    const q=room.qs[room.qi];
    const pts=i===q.a?1000+Math.round(500*(room.endsAt-now)/(QT*1000)):0;
    p.answer={i,pts};p.score+=pts;
    if([...room.players.values()].filter(x=>x.ws).every(x=>x.answer))closeQ(room);
    else broadcast(room);
  }
}
wss.on('connection',ws=>{
  ws.alive=true;ws.on('pong',()=>ws.alive=true);
  ws.on('message',d=>{let m;try{m=JSON.parse(d)}catch{return}
    if(m&&typeof m.t==='string')try{handle(ws,m)}catch(e){console.error(e)}});
  ws.on('close',()=>{
    const room=ws.room;if(!room)return;
    const p=room.players.get(ws.pid);if(!p||p.ws!==ws)return;
    p.ws=null;p.dc=Date.now();dropHost(room);
    if(![...room.players.values()].some(x=>x.ws))room.emptyAt=Date.now();
    else if(room.phase==='question'&&[...room.players.values()].filter(x=>x.ws).every(x=>x.answer))closeQ(room);
    broadcast(room);
  });
});
setInterval(()=>{
  for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue}ws.alive=false;ws.ping()}
  const now=Date.now();
  for(const [c,room] of rooms){
    if(room.emptyAt&&now-room.emptyAt>ROOM_TTL){clearTimeout(room.timer);rooms.delete(c);continue}
    if(room.phase==='lobby'){let ch=false;
      for(const [id,p] of room.players)if(!p.ws&&p.dc&&now-p.dc>LOBBY_GRACE){room.players.delete(id);ch=true}
      if(ch){dropHost(room);broadcast(room)}}
  }
},5000);
server.listen(PORT,()=>console.log('Brain Battle on :'+PORT));
module.exports={server};
