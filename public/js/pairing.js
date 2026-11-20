(()=>{
'use strict';
const C=window.BeamSyncCore,{$,S,hooks,log,show,status,progress,addTimer,beginAttempt,makePC,wireChannel,waitIce,pairStats,enc,dec,b64u,unb64u,randId}=C;
const QR_PART=850;
let qrParts=[],qrIndex=0,qrTimer=null,expectedQr=null,cameraEpoch=0,cameraStream=null,scanRaf=null,lastScan='';
const qrBuckets=new Map(),qrConsumed=new Set();

function openPair(title,instruction){show('pairCard',true);$('pairTitle').textContent=title;$('pairInstruction').textContent=instruction;show('connectedCard',false)}
function prepareAttempt(){beginAttempt();qrBuckets.clear();qrConsumed.clear();expectedQr=null;show('rescueBox',false);show('scanProgress',false)}

async function zip(bytes){if(!('CompressionStream'in window))return{alg:'raw',bytes};const z=new CompressionStream('gzip'),w=z.writable.getWriter();w.write(bytes);w.close();return{alg:'gz',bytes:new Uint8Array(await new Response(z.readable).arrayBuffer())}}
async function unzip(bytes,alg) {
  if (alg === 'raw') return bytes;
  if (alg !== 'gz' || !('DecompressionStream' in window)) throw Error('Unsupported QR encoding.');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw Error('Pairing code is too large.'); }
      parts.push(value);
    }
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  } finally { reader.releaseLock(); }
}
async function packSDP(d){const z=await zip(enc.encode(JSON.stringify({v:2,type:d.type,sdp:d.sdp})));return z.alg+'.'+b64u(z.bytes)}
async function unpackSDP(s,type){if(s.length>17000)throw Error('Pairing code is too large.');const p=s.indexOf('.');if(p<1)throw Error('Invalid handshake.');const o=JSON.parse(dec.decode(await unzip(unb64u(s.slice(p+1)),s.slice(0,p))));if(o.v!==2||o.type!==type||typeof o.sdp!=='string'||!/^v=0\r?\n/.test(o.sdp)||!/^a=fingerprint:sha-256 /im.test(o.sdp)||!/^m=application .*webrtc-datachannel/im.test(o.sdp)||o.sdp.split(/\r?\n/).some(line=>line.startsWith('m=')&&!line.startsWith('m=application ')))throw Error('Unsupported handshake.');return{type:o.type,sdp:o.sdp}}
function splitQr(kind,payload){const sid=randId(5).toUpperCase(),n=Math.ceil(payload.length/QR_PART),out=[];if(n>20)throw Error('Handshake is too large for QR mode.');for(let i=0;i<n;i++)out.push(`BSQ8|${kind}|${sid}|${i+1}|${n}|${payload.slice(i*QR_PART,(i+1)*QR_PART)}`);return out}
function ingestQr(s){if(!s.startsWith('BSQ8|'))throw Error('Not a BeamSync handshake QR.');const x=s.split('|');if(x.length!==6)throw Error('Invalid QR.');const[,kind,sid,is,ns,p]=x,i=+is,n=+ns;if(!['O','A','R','S'].includes(kind)||!/^[A-F0-9]{10}$/.test(sid)||!Number.isInteger(n)||!Number.isInteger(i)||!p.length||p.length>QR_PART||i<1||i>n||n>20)throw Error('Invalid QR.');const key=kind+':'+sid;if(qrConsumed.has(key)){show('scanProgress',true);$('scanProgress').className='status ok';$('scanProgress').textContent='Already scanned ✓ — no need to scan this QR again.';return null}let b=qrBuckets.get(key);if(!b){if(qrBuckets.size>=4)qrBuckets.delete(qrBuckets.keys().next().value);b={kind,n,m:new Map()};qrBuckets.set(key,b)}if(b.n!==n)throw Error('QR part count mismatch.');b.m.set(i,p);show('scanProgress',true);$('scanProgress').className='status subtle';$('scanProgress').textContent=`Scanned ${b.m.size} of ${n} QR piece${n===1?'':'s'}.`;if(b.m.size!==n)return null;const payload=Array.from({length:n},(_,j)=>b.m.get(j+1)).join('');qrBuckets.delete(key);$('scanProgress').className='status ok';$('scanProgress').textContent='Complete handshake captured ✓';return{kind,sid,payload}}
function outgoingQr(title,instruction,parts,scanner=false){openPair(title,instruction);qrParts=parts;qrIndex=0;show('qrArea',true);show('scannerArea',scanner);renderQr();startQrRotation();const k=parts[0]?.split('|')[1]||'',payload=parts.map(x=>x.split('|')[5]).join('');$('manualOut').value=`BSQ8TEXT|${k}|${payload}`}
function renderQr(){if(!qrParts.length)return;const text=qrParts[qrIndex],box=$('qr');box.innerHTML='';try{const q=qrcode(0,'L');q.addData(text);q.make();box.innerHTML=q.createSvgTag({cellSize:4,margin:8,scalable:true})}catch{box.textContent='QR generation failed — use Manual fallback.'}const k=text.split('|')[1],name={O:'Offer',A:'Answer',R:'Rescue offer',S:'Rescue answer'}[k]||'Handshake';$('qrMeta').textContent=`${name} part ${qrIndex+1} of ${qrParts.length}${qrParts.length>1?' — capture each part once':' — scan once'}`;$('qrPrev').disabled=$('qrNext').disabled=qrParts.length<2}
function qrStep(d){if(!qrParts.length)return;qrIndex=(qrIndex+d+qrParts.length)%qrParts.length;renderQr()}
function startQrRotation(){stopQrRotation();$('qrPause').textContent='Pause rotation';if(qrParts.length>1)qrTimer=setInterval(()=>qrStep(1),950)}
function stopQrRotation(){if(qrTimer){clearInterval(qrTimer);qrTimer=null}}
function toggleQrRotation(){if(qrTimer){stopQrRotation();$('qrPause').textContent='Resume rotation'}else startQrRotation()}

async function directStart(){if(S.stage!=='idle')throw Error('A connection attempt is already active. Reset before starting another one.');const net=$('directNetwork').value;if(net==='stun'&&!navigator.onLine)throw Error('Different-networks mode needs internet access for public STUN. Choose Same Wi-Fi / hotspot while offline.');prepareAttempt();S.pairing='direct';S.role='A';S.stage='d-a-building';openPair('Direct QR — Device A','Creating the first QR handshake.');progress('Creating offer and gathering routes…','warn');const pc=makePC(net);wireChannel(pc.createDataChannel('beamsync-v8',{ordered:true}));await pc.setLocalDescription(await pc.createOffer());await waitIce(pc);const p=await packSDP(pc.localDescription);if(S.pc!==pc||S.dc?.readyState==='open')return;expectedQr='A';S.stage='d-a-wait-answer';outgoingQr('Device A — show this to Device B','Have the receiver scan every part of your QR. Then use this device’s camera to scan the reply on the receiver’s screen.',splitQr('O',p),true);progress('This screen stays on your QR until you scan the reply. When the receiver shows a new QR, tap Open live camera here.','warn')}
async function directJoin(){if(S.stage!=='idle')throw Error('A connection attempt is already active. Reset before joining another one.');const net=$('directNetwork').value;if(net==='stun'&&!navigator.onLine)throw Error('Different-networks mode needs internet access for public STUN. Choose Same Wi-Fi / hotspot while offline.');prepareAttempt();S.pairing='direct';S.role='B';S.stage='d-b-wait-offer';makePC(net);expectedQr='O';openPair('Direct QR — Device B','Scan every part of the sender’s QR. Your reply QR will appear here for the sender to scan.');show('qrArea',false);show('scannerArea',true);progress('Waiting for Device A offer…','warn')}
async function handleDirectQr(x){if(expectedQr&&x.kind!==expectedQr){status('Scanned the wrong handshake type for the current step.','warn');return}if(x.kind==='O')await gotDirectOffer(x);else if(x.kind==='A')await gotDirectAnswer(x);else if(x.kind==='R')await gotRescueOffer(x);else if(x.kind==='S')await gotRescueAnswer(x)}
function revealReply(pc) {
  requestAnimationFrame(() => {
    if (S.pc !== pc || S.stage !== 'd-b-answer-ready') return;
    const heading = $('pairTitle');
    heading.focus({preventScroll:true});
    heading.scrollIntoView({block:'start'});
  });
}
async function gotDirectOffer(x){if(S.role!=='B'||S.stage!=='d-b-wait-offer')return;const pc=S.pc;S.stage='d-b-processing';await pc.setRemoteDescription(await unpackSDP(x.payload,'offer'));await pc.setLocalDescription(await pc.createAnswer());await waitIce(pc);const p=await packSDP(pc.localDescription);if(S.pc!==pc||S.dc?.readyState==='open')return;qrConsumed.add('O:'+x.sid);expectedQr=null;S.stage='d-b-answer-ready';stopCamera();outgoingQr('Reply ready — show this QR to the sender','Show this reply on your screen. The sender scans every part of it with the sender’s camera.',splitQr('A',p),false);progress('The sender uses Open live camera on their device to scan this reply. Keep this QR visible.','ok');revealReply(pc);armDirectRescue()}
async function gotDirectAnswer(x){if(S.role!=='A'||S.stage!=='d-a-wait-answer')return;const pc=S.pc;S.stage='d-a-processing-answer';await pc.setRemoteDescription(await unpackSDP(x.payload,'answer'));if(S.pc!==pc||S.dc?.readyState==='open')return;qrConsumed.add('A:'+x.sid);expectedQr=null;S.stage='d-a-answer-applied';stopCamera();stopQrRotation();show('qrArea',false);show('scannerArea',false);progress('QR exchange complete ✓ • Opening direct route…','warn');armDirectRescue()}
function armDirectRescue(){const a=S.attempt;addTimer(()=>{if(a!==S.attempt||S.dc?.readyState==='open'||S.directRescueRound>0)return;showDirectRescue()},12000)}
function showDirectRescue(){if(S.directRescueRound>0||S.dc?.readyState==='open')return;show('rescueBox',true);show('rescueStart',S.role==='A');show('rescueJoin',S.role==='B');$('rescueText').textContent=S.role==='A'?'The normal QR exchange completed, but the direct route did not open. Create one fresh ICE-restart QR.':'If Device A offers Connection Rescue, tap Scan rescue QR and capture its fresh restart offer.';progress('Direct route still closed • Connection Rescue available.','warn')}
async function directRescueStart(){if(S.role!=='A'||S.stage!=='d-a-answer-applied'||S.dc?.readyState==='open')return;const pc=S.pc;S.directRescueRound=1;show('rescueBox',false);S.stage='d-a-rescue-building';pc.restartIce?.();await pc.setLocalDescription(await pc.createOffer({iceRestart:true}));await waitIce(pc);const p=await packSDP(pc.localDescription);if(S.pc!==pc||S.dc?.readyState==='open')return;expectedQr='S';S.stage='d-a-wait-rescue-answer';outgoingQr('Device A — Connection Rescue','Device B taps Scan rescue QR and captures every rescue-offer part. Then scan its rescue answer here.',splitQr('R',p),true);progress('Fresh ICE restart offer ready.','warn')}
async function directRescueJoin(){if(S.role!=='B'||S.stage!=='d-b-answer-ready'||S.dc?.readyState==='open')return;S.directRescueRound=1;show('rescueBox',false);S.stage='d-b-wait-rescue';expectedQr='R';show('qrArea',false);show('scannerArea',true);$('pairInstruction').textContent='Scan every rescue-offer QR part from Device A.';progress('Waiting for Device A rescue offer…','warn')}
async function gotRescueOffer(x){if(S.role!=='B'||S.stage!=='d-b-wait-rescue')return;const pc=S.pc;S.stage='d-b-processing-rescue';await pc.setRemoteDescription(await unpackSDP(x.payload,'offer'));await pc.setLocalDescription(await pc.createAnswer());await waitIce(pc);const p=await packSDP(pc.localDescription);if(S.pc!==pc||S.dc?.readyState==='open')return;qrConsumed.add('R:'+x.sid);expectedQr=null;S.stage='d-b-rescue-answer-ready';stopCamera();outgoingQr('Device B — show rescue answer','Show this rescue reply to the sender. The sender scans every part. Keep both pages open.',splitQr('S',p),false);progress('Rescue answer ready ✓','ok')}
async function gotRescueAnswer(x){if(S.role!=='A'||S.stage!=='d-a-wait-rescue-answer')return;const pc=S.pc;S.stage='d-a-processing-rescue';await pc.setRemoteDescription(await unpackSDP(x.payload,'answer'));if(S.pc!==pc||S.dc?.readyState==='open')return;qrConsumed.add('S:'+x.sid);expectedQr=null;S.stage='d-a-rescue-applied';stopCamera();stopQrRotation();show('qrArea',false);show('scannerArea',false);progress('Fresh route negotiated ✓ • Connecting…','warn');const a=S.attempt;addTimer(()=>{if(a===S.attempt&&S.dc?.readyState!=='open')progress('Connection Rescue completed, but no direct path opened. This network may require a relay.','err')},15000)}

async function startCamera() {
  stopCamera();
  const epoch = cameraEpoch;
  if (!navigator.mediaDevices?.getUserMedia) { status('Camera unavailable. Import a QR image or paste the code.', 'warn'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    if (epoch !== cameraEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
    cameraStream = stream;
    $('video').srcObject = stream;
    await $('video').play();
    if (epoch !== cameraEpoch) return;
    show('cameraBox',true); scanLoop();
  } catch {
    if (epoch === cameraEpoch) { stopCamera(); status('Camera could not open. Import a QR image or paste the code.', 'warn'); }
  }
}
function stopCamera() {
  cameraEpoch++;
  if (scanRaf) cancelAnimationFrame(scanRaf);
  scanRaf=null;
  cameraStream?.getTracks().forEach(t=>t.stop());
  cameraStream=null;
  if ($('video')) $('video').srcObject=null;
  show('cameraBox',false);
}
function decodeCanvas(c){if(typeof jsQR!=='function')throw Error('QR decoder unavailable.');const ctx=c.getContext('2d',{willReadFrequently:true}),im=ctx.getImageData(0,0,c.width,c.height),r=jsQR(im.data,im.width,im.height,{inversionAttempts:'attemptBoth'});return r?.data||null}
async function scanLoop(){if(!cameraStream)return;const v=$('video'),c=$('canvas');if(v.readyState>=2&&v.videoWidth){const scale=Math.min(1,900/v.videoWidth);c.width=Math.floor(v.videoWidth*scale);c.height=Math.floor(v.videoHeight*scale);c.getContext('2d').drawImage(v,0,0,c.width,c.height);try{const q=decodeCanvas(c);if(q&&q!==lastScan){lastScan=q;await handleScanned(q);addTimer(()=>{if(lastScan===q)lastScan=''},1000)}}catch(e){log(e.message)}}scanRaf=requestAnimationFrame(scanLoop)}
async function scanImage(file){
  const epoch=cameraEpoch;
  await window.BeamSyncImagePreflight.inspect(file,{maxBytes:20*1024*1024,sizeMessage:'Choose a QR photo under 20 MiB.'});
  if(epoch!==cameraEpoch)return;
  const bmp=await createImageBitmap(file);
  let c;
  try{
    if(epoch!==cameraEpoch)return;
    c=$('canvas');const scale=Math.min(1,1600/Math.max(bmp.width,bmp.height));
    c.width=Math.floor(bmp.width*scale);c.height=Math.floor(bmp.height*scale);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
  }finally{bmp.close()}
  const q=decodeCanvas(c);
  if(!q)throw Error('No QR code found in that image.');
  if(epoch===cameraEpoch)await handleScanned(q);
}
async function handleScanned(text){if(text.startsWith('BSQ8|')){const x=ingestQr(text);if(x)await handleDirectQr(x);return}log('Unrecognized QR ignored.')}
function manualApply(){try{if($('manualIn').value.length>17500)throw Error('Pairing code is too large.');const s=$('manualIn').value.trim(),x=s.split('|');if(x[0]!=='BSQ8TEXT'||!['O','A','R','S'].includes(x[1])||!x[2]||x.length!==3)throw Error('Paste a complete BSQ8TEXT handshake.');handleDirectQr({kind:x[1],sid:'manual',payload:x.slice(2).join('|')}).catch(e=>status(e.message,'err'))}catch(e){status(e.message,'err')}}

function onConnected(){S.stage='connected';C.clearTimers();stopCamera();stopQrRotation();show('pairCard',false);show('connectedCard',true);show('rescueBox',false);status('Connected directly.','ok');log('DataChannel open');pairStats()}
function onFailed(){if(S.directRescueRound===0)showDirectRescue()}
function onClosed(){if(S.stage==='connected')status('Connection closed.','warn')}
function resetPairing(){C.beginAttempt();stopCamera();stopQrRotation();C.hardClose();S.role=null;S.stage='idle';S.directRescueRound=0;qrParts=[];lastScan='';expectedQr=null;qrBuckets.clear();qrConsumed.clear();for(const id of ['manualOut','manualIn'])if($(id))$(id).value='';if($('qr'))$('qr').replaceChildren();show('pairCard',false);show('connectedCard',false);show('scannerArea',false);show('qrArea',false);show('rescueBox',false);log('Session reset')}

hooks.onConnected=onConnected;hooks.onFailed=onFailed;hooks.onClosed=onClosed;
window.BeamSyncPairing={directStart,directJoin,directRescueStart,directRescueJoin,startCamera,stopCamera,scanImage,qrStep,toggleQrRotation,manualApply,resetPairing};
})();
