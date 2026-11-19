import {createUI} from './ui.js?v=14-r14';

const C = window.BeamSyncCore;
const P = window.BeamSyncPairing;
const T = window.BeamSyncTransfer;
const Q = window.BeamSyncQuick;
const R = window.BeamSyncRecovery;
const share = window.BeamSyncShare;
const $ = C.$;
const ui = createUI((name, payload = {}) => act(name, payload).catch(report));
let identity, expected = null, transferBusy = false;
let storePromise, deferredInstall, resetInProgress = false;
let verificationTimer, reconnectRequest;
const textReceipts = new Map();
function getStore() {
  if (!storePromise) storePromise = window.BeamSyncDevices.openStore().catch(error => { storePromise = null; throw error; });
  return storePromise;
}
function report(error) {
  if (error?.name === 'AbortError') return;
  ui.status(error?.message || 'This action could not finish. Try again.', 'error');
  renderConnection();
}
function proofPending() { return Boolean(expected && (identity?.state.status !== 'trusted' || identity?.state.peerId !== expected)); }
function renderConnection() {
  const transport = C.S.dc?.readyState === 'open';
  const connected = transport && !proofPending();
  const peer = identity?.state.status === 'trusted' ? identity.state.label : '';
  ui.connection({connected, busy:transferBusy || (!connected && C.S.stage !== 'idle'),
    label:connected ? (peer || 'Connected directly') : (transport ? 'Verifying device' : C.S.stage === 'idle' ? 'No device connected' : 'Pairing devices'),
    peer, verified:!!peer, canTrust:transport && !proofPending()});
}
function recognition(state) {
  renderConnection();
  if (state.status === 'closed') return;
  if (expected && ['mismatch','failed'].includes(state.status)) {
    endSession();
    ui.status('The connected browser could not prove it was the saved device. The session was closed.', 'error'); return;
  }
  const labels = {idle:'Both devices can compare a code to remember each other.',
    requested:'The other device wants to compare codes. Choose Compare device codes to continue.',
    waiting:'Choose Compare device codes on the other device.',
    verifying:'Verifying this connection…', new:'Compare every group on the two screens.',
    trusted:'Recognized as ' + (state.label || 'a saved device') + '.', failed:state.message};
  ui.recognition({code:state.code || '', label:labels[state.status] || state.message,
    canIdentify:['idle','requested'].includes(state.status), canTrust:state.status === 'new', trusted:state.status === 'trusted'});
  if (state.status === 'requested') ui.status(labels.requested, 'info');
  if (state.status === 'trusted') { clearTimeout(verificationTimer); refreshDevices(); }
}
async function refreshDevices() {
  try {
    const saved = await (await getStore()).list();
    ui.devices(saved.map(v => ({id:v.id,name:v.label,trusted:true,lastSeen:v.lastSeen})));
  } catch { ui.devices([]); }
}
async function refreshPartials() {
  try {
    const entries = await R.list();
    ui.partials(entries.map(v => ({id:v.key, name:v.name, bytes:v.offset, size:v.size, active:v.active, expiresAt:v.expiresAt})));
  } catch { ui.partials([]); }
}
function endSession() {
  if (resetInProgress) return;
  resetInProgress = true;
  try {
    clearTimeout(verificationTimer); reconnectRequest = null; textReceipts.clear(); const old = identity; identity = null; expected = null;
    old?.close(); Q.reset(); P.resetPairing(); T.resetTransfers();
    transferBusy = false; ui.incoming(null); ui.pendingInvite(''); ui.dismissInvite(); ui.closeOffline();
    ui.resetProgress(); renderConnection(); refreshPartials();
  } finally { resetInProgress = false; }
}
function requirePeer() {
  if (C.S.dc?.readyState !== 'open' || proofPending()) throw Error('Connect and verify the device first.');
}
function reconnectHint() {
  return Q.enabled && navigator.onLine !== false
    ? 'On the sending device, tap Send → Create pairing QR. Scan the new code on the receiving device and tap Join this device.'
    : 'Create a new offline QR on the sender and exchange both scans again.';
}
function options() {
  return {network:navigator.onLine === false ? 'lan' : $('network-mode')?.value || 'lan',
    onInvite:(url,expiresAt) => ui.invite({url,expiresAt}), onStatus:text => {
      if (C.S.stage === 'idle') ui.dismissInvite();
      renderConnection(); ui.status(text, 'info');
    }};
}
async function offline(role) {
  if (C.S.stage !== 'idle') throw Error('Finish or cancel the current connection first.');
  $('directNetwork').value = options().network;
  ui.openOffline();
  try {
    const started = role === 'receive' ? P.directJoin() : P.directStart();
    renderConnection(); await started;
  } catch (error) { endSession(); throw error; }
}
async function act(name, data) {
  switch (name) {
    case 'pair': case 'join': {
      reconnectRequest = null;
      try { await (name === 'pair' ? Q.start(options()) : Q.join(data.code, options())); }
      catch (error) { if (C.S.stage === 'idle') { ui.dismissInvite(); renderConnection(); } throw error; }
      return;
    }
    case 'offlinePair': reconnectRequest = null; return offline(data.role);
    case 'closeOffline': case 'disconnect': endSession(); ui.status('Disconnected. ' + reconnectHint(), 'info'); return;
    case 'sendFiles': requirePeer(); return T.sendFiles(data.files);
    case 'accept': requirePeer(); return T.acceptFiles({recover:!!data.recover, peer:identity?.state.status === 'trusted' ? identity.state.peerId : ''});
    case 'decline': return T.declineFiles();
    case 'cancel': return T.cancelTransfer();
    case 'sendText': {
      requirePeer();
      const frame = share.makeFrame(data.text, share.safeURL(data.text) ? 'url' : 'text');
      frame.messageId = C.randId(12);
      C.S.dc.send(JSON.stringify(frame));
      if (textReceipts.size >= 16) textReceipts.delete(textReceipts.keys().next().value);
      textReceipts.set(frame.messageId, C.S.dc);
      ui.setText(''); ui.status('Message sent. Receipt is unconfirmed.', 'info'); return;
    }
    case 'copyText': return share.copyText(data.text);
    case 'pasteText': ui.setText(await share.readClipboard()); return;
    case 'clearReceived': T.clearReceived(); ui.clearReceived?.(); return;
    case 'identify': {
      if (!identity) throw Error('Device recognition is unavailable in this browser session.');
      return identity.start();
    }
    case 'trust': {
      if (!identity) throw Error('Connect a device first.');
      await identity.remember(data.name || $('device-name')?.value || 'My device', data.code || identity.state.code); return refreshDevices();
    }
    case 'reconnect': {
      if (C.S.stage !== 'idle') throw Error('Disconnect the current session before reconnecting.');
      const request = {}; reconnectRequest = request;
      const record = await (await getStore()).get(data.id);
      if (reconnectRequest !== request || C.S.stage !== 'idle') return;
      reconnectRequest = null;
      if (!record) throw Error('This device is no longer saved.');
      expected = record.id; ui.tab('send');
      ui.status('Pair with ' + record.label + '. Both browsers must verify their identity before sharing.', 'info');
      try { return await (Q.enabled && navigator.onLine ? act('pair', {}) : offline('send')); }
      catch (error) { if (C.S.stage === 'idle' && expected === record.id) expected = null; throw error; }
    }
    case 'forget': {
      const store = await getStore();
      await store.forget(data.id);
      if (identity?.state.peerId === data.id || expected === data.id) endSession();
      return refreshDevices();
    }
    case 'discard': await R.forget(data.id); return refreshPartials();
    default: throw Error('This action is unavailable.');
  }
}
const transferMessage = C.hooks.onMessage, pairingConnected = C.hooks.onConnected, pairingFailed = C.hooks.onFailed;
C.hooks.onConnected = () => {
  pairingConnected?.(); ui.closeOffline(); ui.dismissInvite(); renderConnection();
  const pc = C.S.pc, dc = C.S.dc, pin = expected;
  const session = window.BeamSyncDevices.createSession({pc, expectedId:pin,
    store:Object.fromEntries(['identity','touch','save'].map(key => [key, async (...args) => (await getStore())[key](...args)])),
    send:frame => { if (dc === C.S.dc && dc.readyState === 'open') dc.send(JSON.stringify(frame)); },
    onChange:state => { if (C.S.pc === pc && !resetInProgress) recognition(state); }});
  identity = session; recognition(session.state);
  if (pin) {
    verificationTimer = setTimeout(() => {
      if (identity !== session || !proofPending()) return;
      endSession(); ui.status('Saved-device verification timed out. Reconnect and compare codes on the other screen.', 'warn');
    }, 45000);
    session.start().catch(report);
  }
  ui.status(pin ? 'Waiting for the saved device to verify its identity.' : 'Connected. You can now share files or text.', 'success');
};
C.hooks.onClosed = () => { endSession(); ui.status('Connection closed. ' + reconnectHint() + ' Then offer the same file to resume.', 'warn'); };
C.hooks.onFailed = () => {
  if (C.S.pairing === 'direct' && C.S.stage !== 'connected') { pairingFailed?.(); return; }
  endSession(); ui.status('Direct connection lost. Reconnect on the same Wi-Fi or hotspot. Saved transfers can resume when you offer the same file.', 'warn');
};
C.hooks.onMessage = event => {
  if (event.target !== C.S.dc) return;
  if (typeof event.data === 'string' && event.data.length <= 12288) {
    let frame;
    try { frame = JSON.parse(event.data); } catch {}
    if (frame?.t === 'device-v1') { identity?.receive(frame)?.catch(report); return; }
    if (proofPending()) return;
    if (frame?.t === 'chat-ack') {
      if (typeof frame.messageId === 'string' && textReceipts.get(frame.messageId) === C.S.dc) {
        textReceipts.delete(frame.messageId);
        ui.status('Message received by the other device.', 'success');
      }
      return;
    }
    if (frame?.t === 'chat') {
      const message = share.parseFrame(frame);
      if (message) {
        ui.shared(message); ui.status('Message received. Open Receive to view it.', 'info');
        if (/^[0-9a-f]{24}$/.test(frame.messageId || '')) {
          try { C.S.dc.send(JSON.stringify({t:'chat-ack',messageId:frame.messageId})); } catch {}
        }
      }
      return;
    }
  }
  if (!proofPending()) transferMessage?.(event);
};
window.addEventListener('beamsync-transfer', ({detail:d}) => {
  switch (d.type) {
    case 'offer': ui.incoming({files:d.files,peer:identity?.state.label || 'Connected device',canRecover:d.resumeSupported && !!window.indexedDB}); ui.tab('receive'); break;
    case 'offer-closed': ui.incoming(null); break;
    case 'progress': transferBusy = true; ui.progress({name:d.name, done:d.bytes,total:d.total,rate:d.rate,eta:d.eta,label:d.direction==='send'?'Sending file':'Receiving file'}); break;
    case 'status':
      transferBusy = d.state === 'active' || d.state === 'pending';
      renderConnection();
      if (!transferBusy) { ui.resetProgress(); refreshPartials(); }
      else ui.progress({name:'',done:0,total:0,label:d.message});
      if (!resetInProgress) ui.status(d.message, d.state === 'error' ? 'error' : d.state === 'success' ? 'success' : 'info');
      break;
    case 'capability': ui.status(d.message,'warn'); break;
    case 'received': ui.received(d); refreshPartials(); break;
    case 'cleared': ui.clearReceived?.(); break;
  }
});
window.addEventListener('beamsync-diagnostics', e => ui.diagnostics(e.detail));
window.addEventListener('beamsync-status', e => { if (!resetInProgress) ui.status(e.detail.message, e.detail.kind === 'err' ? 'error' : 'info'); });
function bind(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(report)); }
bind('qrPrev', () => P.qrStep(-1)); bind('qrNext', () => P.qrStep(1)); bind('qrPause', P.toggleQrRotation);
bind('cameraOpen', P.startCamera); bind('cameraStop', P.stopCamera); bind('rescueStart', P.directRescueStart);
bind('rescueJoin', P.directRescueJoin); bind('applyManual', P.manualApply); bind('reset', endSession);
bind('copyManual', async () => {
  try { await navigator.clipboard.writeText($('manualOut').value); }
  catch { $('manualOut').focus(); $('manualOut').select(); ui.status('Select Copy to copy the pairing code.', 'info'); }
});
$('imagePick').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (file) P.scanImage(file).catch(report);
};
function updatePairing() {
  ui.pairingAvailable(Q.enabled && navigator.onLine !== false, Q.enabled ? 'Offline QR works without internet access.' : 'One-scan pairing is disabled in this release.');
}
function offlineReady() {
  ui.offline('Ready for offline use on this browser. On iPad, use Safari’s Share → Add to Home Screen for easy access.');
}
async function installOffline() {
  if (!('serviceWorker' in navigator)) { ui.offline('Offline installation is unavailable in this browser.'); return; }
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.cache !== 'beamsync-v14-r14') return;
    if (e.data.type === 'OFFLINE_READY') offlineReady();
    if (e.data?.type === 'OFFLINE_CACHE_ERROR') ui.offline('Offline setup is incomplete. Reopen while online to retry.');
  });
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', {scope:'./',updateViaCache:'none'});
    const ready = await navigator.serviceWorker.ready;
    const ping = () => (reg.active || ready.active)?.postMessage({type:'CACHE_SHELL'});
    navigator.serviceWorker.addEventListener('controllerchange', ping); ping();
  } catch { ui.offline('Offline setup is incomplete. Reopen while online to retry.'); }
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall=e; if ($('install-new')) $('install-new').hidden=false; });
$('install-new')?.addEventListener('click', async () => { if (!deferredInstall) return; const event=deferredInstall; deferredInstall=null; $('install-new').hidden=true; await event.prompt(); });
addEventListener('online',updatePairing); addEventListener('offline',updatePairing);
addEventListener('pagehide', e => { endSession(); if (!e.persisted) T.clearReceived(); });
addEventListener('pageshow', () => { refreshPartials(); refreshDevices(); readPageInvite(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) P.stopCamera(); else if (C.S.dc?.readyState === 'open') C.pairStats(); });
$('recovery-fold')?.addEventListener('toggle', () => { if ($('recovery-fold').open) refreshPartials(); });
updatePairing(); renderConnection(); refreshDevices(); refreshPartials(); installOffline();
function receivePageInvite(url) {
  if (!url || !Q.enabled) return;
  if (C.S.stage === 'idle') ui.pendingInvite(url);
  else ui.status(C.S.stage === 'connected'
    ? 'This device is already connected. To join the new invitation, tap Disconnect and scan the new QR again.'
    : 'Pairing is already in progress. To use the new invitation, tap Cancel pairing and scan the new QR again.', 'info');
}
function readPageInvite() { receivePageInvite(window.BeamSyncSignal.takeInvite()); }
window.addEventListener('hashchange', readPageInvite);
receivePageInvite(Q.startupInvite);
