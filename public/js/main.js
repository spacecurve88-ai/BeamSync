(()=>{
'use strict';
const C=window.BeamSyncCore,P=window.BeamSyncPairing,T=window.BeamSyncTransfer,{$,show,log,status}=C;
let offlineReady=false,deferredInstall=null;

function resetAll(){P.resetPairing();T.resetTransfers()}
function wrap(fn){return()=>Promise.resolve(fn()).catch(e=>status(e?.message||String(e),'err'))}

$('directStart').onclick=wrap(P.directStart);
$('directJoin').onclick=wrap(P.directJoin);
$('qrPrev').onclick=()=>P.qrStep(-1);
$('qrNext').onclick=()=>P.qrStep(1);
$('qrPause').onclick=P.toggleQrRotation;
$('cameraOpen').onclick=wrap(()=>P.startCamera());
$('cameraStop').onclick=P.stopCamera;
$('imagePick').onchange=e=>{const f=e.target.files[0];if(f)P.scanImage(f).catch(x=>status(x.message,'err'));e.target.value=''};
$('rescueStart').onclick=wrap(P.directRescueStart);
$('rescueJoin').onclick=wrap(P.directRescueJoin);
$('copyManual').onclick=async()=>{try{await navigator.clipboard.writeText($('manualOut').value)}catch{$('manualOut').focus();$('manualOut').select();status('Select Copy to copy the pairing code.')}};
$('applyManual').onclick=P.manualApply;
$('reset').onclick=resetAll;
$('disconnect').onclick=resetAll;
$('offerFiles').onclick=wrap(T.offerFiles);
$('cancelTransfer').onclick=T.cancelTransfer;
$('clearDownloads').onclick=T.clearReceived;
C.hooks.onClosed=()=>{resetAll();status('Connection closed. Pair again to share.', 'warn');};
window.addEventListener('pagehide',resetAll);
$('acceptFiles').onclick=wrap(T.acceptFiles);
$('declineFiles').onclick=T.declineFiles;
$('sendMessage').onclick=T.sendMessage;
$('message').onkeydown=e=>{if(e.key==='Enter')T.sendMessage()};

function standalone(){return !!(window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true)}
function updateOnline(){document.body.classList.toggle('offline',!navigator.onLine);$('netBadge').textContent=navigator.onLine?'Internet online':'Internet offline';updateOfflineUI()}
function updateOfflineUI(){const s=$('offlineStatus'),h=$('installHelp'),ios=/iPad|iPhone|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);if(!('serviceWorker'in navigator)){s.textContent='Not supported';s.className='badge warn'}else if(offlineReady){s.textContent='Offline ready ✓';s.className='badge'}else{s.textContent='Preparing…';s.className='badge warn'}if(standalone()){show('installApp',false);h.textContent='BeamSync is running as an installed app.'}else if(ios){show('installApp',false);h.textContent='On iPad/iPhone: after Offline ready ✓, use Share → Add to Home Screen.'}else if(deferredInstall){show('installApp',true);h.textContent='This browser can install BeamSync for easier offline launching.'}else{show('installApp',false);h.textContent='If your browser offers Install/Add to Home Screen, use it after Offline ready ✓.'}}
async function setupOffline(){updateOnline();window.addEventListener('online',updateOnline);window.addEventListener('offline',updateOnline);window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;updateOfflineUI()});window.addEventListener('appinstalled',()=>{deferredInstall=null;updateOfflineUI()});$('installApp').onclick=async()=>{if(!deferredInstall)return;const p=deferredInstall;deferredInstall=null;try{await p.prompt();await p.userChoice}catch{}updateOfflineUI()};if(!('serviceWorker'in navigator))return;navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.cache!=='beamsync-v14-r8')return;if(e.data.type==='OFFLINE_READY'){offlineReady=true;log('Offline package ready');updateOfflineUI()}else if(e.data?.type==='OFFLINE_CACHE_ERROR'){log('Offline cache error: '+(e.data.message||'unknown'));$('offlineStatus').className='badge warn';$('offlineStatus').textContent='Cache failed'}});try{const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./'}),ready=await navigator.serviceWorker.ready;const send=()=>{const t=navigator.serviceWorker.controller||ready.active||reg.active||reg.waiting;t?.postMessage({type:'CACHE_SHELL'})};navigator.serviceWorker.addEventListener('controllerchange',send);send();setTimeout(send,1200)}catch(e){log('Service worker setup failed: '+e.message)}updateOfflineUI()}

if(typeof qrcode!=='function')log('QR generator did not load.');
if(typeof jsQR!=='function')log('QR decoder did not load.');
setupOffline().catch(e=>log('Offline setup: '+e.message));
})();