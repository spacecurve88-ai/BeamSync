'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomBytes, webcrypto } = require('node:crypto');
const script = file => fs.readFileSync(path.join(__dirname,'../../public/js',file),'utf8');
const legacyPath = path.join(__dirname,'../../baseline-v13/public/js/transfer.js');
const hashScript=script('sha256.js'), transferScript=script('transfer.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const block=1048576;
const later = () => new Promise(r=>setTimeout(r,1));
async function until(fn,timeout=5000) {
  const end=Date.now()+timeout;
  while (!fn()) {
    if (Date.now()>=end) throw Error('Timed out waiting for test condition.');
    await later();
  }
}
function makeDom() {
  const elements=new Map();
  const el=()=>({style:{},classList:{toggle(){}},append(){},appendChild(){},replaceChildren(){},childElementCount:0});
  const byId=id=>{if (!elements.has(id)) elements.set(id,el()); return elements.get(id);};
  return {createElement:el,getElementById:byId};
}
function device({legacy=false,store=new Map()}={}) {
  const events=[], document=makeDom(), dc=new EventTarget(), window=new EventTarget();
  Object.assign(dc,{readyState:'open',bufferedAmount:0,peer:null,transcript:[],beforeSend:undefined});
  dc.send=data=>{
    if (dc.readyState!=='open') throw Error('closed');
    const isText=typeof data==='string';
    const message=isText?JSON.parse(data):undefined;
    if (message) dc.transcript.push(message);
    if (dc.beforeSend && dc.beforeSend(message,data)===false) return;
    const payload=isText?data:Uint8Array.from(new Uint8Array(data.buffer || data,data.byteOffset || 0,data.byteLength)).buffer;
    setImmediate(()=>{if(dc.peer?.dc.readyState==='open') dc.peer.deliver(payload);});
  };
  const core={S:{dc,pc:{sctp:{maxMessageSize:65536}}},hooks:{},$:document.getElementById,show(){},log(){},
    fmtBytes:v=>v+' B',hex:v=>Buffer.from(v).toString('hex'),randId:(n=12)=>randomBytes(n).toString('hex')};
  let opens=0,leaks=0;
  const memoryStore = {
    async open(meta,{resumable,onPrefix,peer=''}) {
      opens++;
      if (memoryStore.failOpen) throw Error('Quota exceeded.');
      const key=meta.sha256+':'+peer;
      const parts=resumable ? (store.get(key)||[]).slice() : [];
      for(const part of parts) onPrefix(part);
      let offset=parts.reduce((a,b)=>a+b.length,0), closed=false;
      leaks++;
      function close(keep){if(closed)return; closed=true;leaks--;if(keep && resumable && parts.length)store.set(key,parts.slice());else store.delete(key);}
      return {get offset(){return offset;},resumable,
        async append(blob,expected){
          const bytes=new Uint8Array(await blob.arrayBuffer()), sha=digest(bytes);
          if (memoryStore.failAfterBlock && offset >= block) throw new DOMException('','QuotaExceededError');
          if (closed || (expected && expected!==sha)) throw Error('Checkpoint invalid.');
          if(bytes.length !== Math.min(block,meta.size-offset)) throw Error('Bad block length.');
          parts.push(bytes);offset+=bytes.length;
          return sha;
        },
        async finish(){if(closed || offset!==meta.size)throw Error('Incomplete');close(false);return new Blob(parts);},
        async interrupt(){close(true);},async discard(){close(false);}
      };
    }
  };
  window.BeamSyncCore=core;window.BeamSyncRecovery=memoryStore;
  window.addEventListener('beamsync-transfer',e=>events.push(e.detail));
  const ctx=vm.createContext({window,document,navigator:{},performance,crypto:webcrypto,Event,CustomEvent,URL,
    TextEncoder,Uint8Array,ArrayBuffer,Blob,AbortController,Error,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(hashScript,ctx); vm.runInContext(legacy?fs.readFileSync(legacyPath,'utf8'):transferScript,ctx);
  return {ctx,store,dc,core,events,document,mode:legacy?'v13':'v14',api:window.BeamSyncTransfer,storage:memoryStore,
    deliver:data=>core.hooks.onMessage({data,target:dc}),
    async close(){dc.readyState='closed';dc.dispatchEvent(new Event('close'));await later();},
    get opens(){return opens;},get leaks(){return leaks;},has:(type,state)=>events.some(e=>e.type===type && (!state||e.state===state))};
}
function connect(a,b){a.dc.peer=b;b.dc.peer=a;}
function offerTo(d,id='batch', size=2) {
  d.deliver(JSON.stringify({t:'proposal',id,v:14,total:size,files:[{id:'0',name:'f.bin',mime:'application/octet-stream',size}]}));
}
const fstart=(id='batch',data=Buffer.from('ok'))=>({t:'file-start',transferId:id,fileId:id+':0',index:0,count:1,name:'f.bin',size:data.length,
  mime:'application/octet-stream',sha256:digest(data)});
function payload(size,name='a.bin') {return new File([randomBytes(size)],name,{type:'application/octet-stream'});}
function offerAccepted(a,b,files,options={}) {
  if(a.mode==='v13'){a.document.getElementById('files').files=files;a.api.offerFiles();}
  else assert.ok(a.api.sendFiles(files));
  return (async()=>{await until(()=>b.mode==='v13'?b.document.getElementById('spaceHint').textContent:b.has('offer'));await b.api.acceptFiles(options);})();
}
function done(d,direction) {
  if(d.mode==='v14')return d.events.some(e=>e.direction===direction && e.state==='success');
  return d.document.getElementById(direction+'Status').className==='status ok';
}
test('incremental SHA-256, random inputs and padding boundaries match Node independently',()=>{
  const {ctx}=device(), SHA=ctx.BeamSHA256;
  for (const size of [0,1,55,56,63,64,65,127,128,129,1000000]) {
    const input=randomBytes(size), state=new SHA();
    for(let i=0;i<size;i+=93)state.update(input.subarray(i,i+93));
    assert.equal(state.hex(),digest(input));
    const snapshot=state.hex();
    state.update(Buffer.from('x'));
    assert.equal(snapshot,digest(input));assert.equal(state.hex(),digest(Buffer.concat([input,Buffer.from('x')])));
  }
});
for(const [sender,receiver] of [[false,false],[false,true],[true,false]]) {
  test((sender?'v13':'v14')+' → '+(receiver?'v13':'v14')+' verified, including empty and multi-block files',
    {skip:(sender||receiver)&&!fs.existsSync(legacyPath)},async()=>{
      const a=device({legacy:sender}),b=device({legacy:receiver});connect(a,b);
      const files=[payload(0,'empty'),payload(2*block+32767)];
      await offerAccepted(a,b,files);
      await until(()=>done(a,'send')&&done(b,'receive'));
      const checks=b.dc.transcript.filter(m=>m.t==='file-confirm');
      assert.equal(checks.length,2);
      for(let i=0;i<files.length;i++)assert.equal(checks[i].sha256,digest(Buffer.from(await files[i].arrayBuffer())));
      assert.equal(b.leaks,0);
      b.api.clearReceived?.();
    });
}
test('reject malformed offers and ignore bytes/start/complete before explicit acceptance',async()=>{
  const b=device();let send=m=>b.deliver(JSON.stringify(m));
  send(fstart());b.deliver(new Uint8Array(2).buffer);send({t:'transfer-complete',id:'batch'});
  for (const size of [-1,'2',null,1.7,300*block]) offerTo(b,'batch',size);
  await later();assert.equal(b.opens,0);assert.equal(b.has('offer'),false);assert.equal(b.has('status','success'),false);
  offerTo(b);assert.ok(b.has('offer'));send(fstart());b.deliver(new Uint8Array(2).buffer);
  await later();assert.equal(b.opens,0);b.api.declineFiles();
});
test('control byte limits reject multibyte overflow and bound queued parsed controls',async()=>{
  const multibyte=device();offerTo(multibyte);multibyte.api.acceptFiles();
  const wide=JSON.stringify({...fstart(),padding:'\u{1f600}'.repeat(17000)});
  assert.ok(wide.length<=65536);assert.ok(Buffer.byteLength(wide,'utf8')>65536);
  multibyte.deliver(wide);
  await until(()=>multibyte.has('status','error'));
  assert.match(multibyte.events.find(e=>e.type==='status'&&e.state==='error').message,/Oversized control message/);
  assert.equal(multibyte.opens,0);

  const queued=device();offerTo(queued);queued.api.acceptFiles();
  const padded=JSON.stringify({...fstart(),padding:'x'.repeat(64000)});
  assert.ok(Buffer.byteLength(padded,'utf8')<=65536);
  for(let i=0;i<64&&!queued.has('status','error');i++)queued.deliver(padded);
  await until(()=>queued.has('status','error'));
  assert.match(queued.events.find(e=>e.type==='status'&&e.state==='error').message,/Receiver could not keep up/);
  await later();assert.equal(queued.opens,0);
});
test('accepted offer constrains filename, index and digest shape; early completion cannot report success',async()=>{
  for(const mutate of [m=>({...m,name:'different'}),m=>({...m,index:1}),m=>({...m,sha256:'forged'}),()=>({t:'transfer-complete',id:'batch'})]){
    const b=device();offerTo(b);b.api.acceptFiles();b.deliver(JSON.stringify(mutate(fstart())));
    await until(()=>b.has('status','error'));assert.equal(b.opens,0);assert.equal(b.has('status','success'),false);
  }
});
test('excess bytes, corrupt checkpoint and wrong final hash fail before any download',async()=>{
  for(const mode of ['overflow','block','file']){
    const b=device();offerTo(b);b.api.acceptFiles({recover:true});
    const start=fstart();if(mode==='file')start.sha256=digest('no');
    b.deliver(JSON.stringify(start));await until(()=>b.dc.transcript.some(m=>m.t==='file-ready'));
    const bytes=Buffer.from(mode==='overflow'?'bad':'ok');
    b.deliver(Uint8Array.from(bytes).buffer);
    b.deliver(JSON.stringify({t:'file-block',fileId:'batch:0',transferId:'batch',offset:2,sha256:digest(mode==='block'?'no':'ok')}));
    b.deliver(JSON.stringify({t:'file-end',fileId:'batch:0',transferId:'batch'}));
    await until(()=>b.has('status','error')&&b.leaks===0);
    assert.equal(b.has('received'),false);assert.equal(b.store.size,0);
  }
});
test('connection loss retains authorized durable block, fresh pair resumes from source-verified prefix',async()=>{
  const store=new Map(),a=device(),b=device({store});connect(a,b);
  const file=payload(2*block+3);let blockAcks=0;
  b.dc.beforeSend=m=>{if(m?.t==='block-ok' && ++blockAcks===1){setImmediate(()=>{b.close();a.close();});return false;}};
  await offerAccepted(a,b,[file],{recover:true,peer:'verified-device'});
  await until(()=>b.leaks===0 && store.size===1);
  assert.equal(Array.from(store.values())[0].length,1);assert.equal(a.has('status','success'),false);
  const c=device(),d=device({store});connect(c,d);await offerAccepted(c,d,[file],{recover:true,peer:'verified-device'});
  await until(()=>done(c,'send')&&done(d,'receive'));
  assert.equal(d.dc.transcript.find(m=>m.t==='file-ready').offset,block);
  assert.ok(c.dc.transcript.some(m=>m.t==='file-proof'));
  assert.equal(store.size,0);d.api.clearReceived();
});
test('forged checkpoint offset or mismatched prefix stops sender before sending bytes',async()=>{
  const a=device(),b=device();connect(a,b);
  b.dc.beforeSend=m=>{if(m?.t==='file-ready'){setImmediate(()=>a.deliver(JSON.stringify({...m,offset:1,prefix:'0'.repeat(64)})));return false;}};
  await offerAccepted(a,b,[payload(32)]);
  await until(()=>a.has('status','error')&&b.leaks===0);
  assert.equal(a.dc.transcript.some(m=>m.t==='file-block'),false);assert.equal(b.has('received'),false);
});
test('store opening failure reaches sender, clears job, and permits fresh offers',async()=>{
  const a=device(),b=device();connect(a,b);b.storage.failOpen=true;
  await offerAccepted(a,b,[payload(4)]);
  await until(()=>a.has('status','error')&&b.has('status','error'));
  b.storage.failOpen=false;b.events.length=0;
  await offerAccepted(a,b,[payload(2)]);await until(()=>done(a,'send'));b.api.clearReceived();
});
test('missing final confirmation prevents sender success and disconnect releases wait',async()=>{
  const a=device(),b=device();connect(a,b);
  b.dc.beforeSend=m=>m?.t==='transfer-confirm'?false:undefined;
  await offerAccepted(a,b,[payload(1)]);await until(()=>done(b,'receive'));
  assert.equal(done(a,'send'),false);await a.close();assert.ok(a.has('status','error'));b.api.clearReceived();
});
test('flow control waits for drain; cancellation settles stalled sender',async()=>{
  const a=device(),b=device();connect(a,b);a.dc.bufferedAmount=8*block;
  await offerAccepted(a,b,[payload(30)]);
  await until(()=>a.dc.bufferedAmountLowThreshold>0);
  assert.equal(a.dc.transcript.some(m=>m.t==='file-block'),false);
  a.api.cancelTransfer();
  await until(()=>b.has('status','cancelled')&&b.leaks===0);assert.equal(done(a,'send'),false);
});

test('a cached complete prefix needs fresh sender proof before receipt',async()=>{
  const bytes=Buffer.from('ok'), sha=digest(bytes), store=new Map([[sha+':',[bytes]]]);
  const b=device({store});offerTo(b);b.api.acceptFiles({recover:true});
  b.deliver(JSON.stringify(fstart('batch',bytes)));
  await until(()=>b.dc.transcript.some(m=>m.t==='file-ready'));
  const ready=b.dc.transcript.find(m=>m.t==='file-ready');
  assert.equal(ready.offset,bytes.length);assert.match(ready.nonce,/^[0-9a-f]{32}$/);
  b.deliver(JSON.stringify({t:'file-proof',fileId:'batch:0',transferId:'batch',proof:sha}));
  await until(()=>b.has('status','error')&&b.leaks===0);
  assert.equal(b.has('received'),false);
});

test('queued receive during closing-before-close-event retains its last verified block',async()=>{
  const bytes=randomBytes(block+4), b=device();
  offerTo(b,'batch',bytes.length);b.api.acceptFiles({recover:true});
  b.deliver(JSON.stringify(fstart('batch',bytes)));
  await until(()=>b.dc.transcript.some(m=>m.t==='file-ready'));
  for(let i=0;i<block;i+=16384)b.deliver(Uint8Array.from(bytes.subarray(i,i+16384)).buffer);
  b.deliver(JSON.stringify({t:'file-block',fileId:'batch:0',transferId:'batch',offset:block,sha256:digest(bytes.subarray(0,block))}));
  await until(()=>b.dc.transcript.some(m=>m.t==='block-ok'));
  b.deliver(Uint8Array.from(bytes.subarray(block)).buffer);
  b.dc.readyState='closing';
  await until(()=>b.leaks===0);
  assert.equal(b.store.size,1);assert.equal([...b.store.values()][0][0].length,block);
});

if (process.argv.includes('--size-test')) {
  test('250 MiB file boundary, bounded source reads, independently checked stored file',async()=>{
    const part=randomBytes(block), filename='limit.bin', file=new File(Array(250).fill(new Blob([part])),filename);
    // Any accidental whole-file read fails immediately.
    file.arrayBuffer=()=>{throw Error('Whole-file memory read');};
    const slice=file.slice.bind(file);
    file.slice=(from,to)=>{assert.ok(to-from<=block);return slice(from,to);};
    const a=device(),b=device();connect(a,b);
    await offerAccepted(a,b,[file]);await until(()=>done(a,'send')&&done(b,'receive'),120000);
    const saved=b.events.find(e=>e.type==='received'), expected=createHash('sha256');
    for(let i=0;i<250;i++)expected.update(part);
    assert.equal(saved.size,250*block);assert.equal(saved.sha256,expected.digest('hex'));
    const blob=require('node:buffer').resolveObjectURL(saved.url), target=digest(part);
    for(let i=0;i<250;i++) {
      assert.equal(digest(Buffer.from(await blob.slice(i*block,(i+1)*block).arrayBuffer())),target);
    }
    assert.equal(b.leaks,0);
    b.api.clearReceived();
  });
}

test('empty-message browser quota error retains opted-in block and explains the storage failure to both peers',async()=>{
  const a=device(), b=device(); connect(a,b); b.storage.failAfterBlock=true;
  await offerAccepted(a,b,[payload(block+3)],{recover:true});
  await until(()=>b.has('status','error')&&a.has('status','error')&&b.leaks===0);
  assert.match(b.events.find(x=>x.state==='error').message,/out of space/);
  assert.match(a.events.find(x=>x.state==='error').message,/could not save/);
  assert.equal(b.store.size,1);assert.equal([...b.store.values()][0][0].byteLength,block);
  assert.equal(b.has('received'),false);
});
