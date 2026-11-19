(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const LAN = {iceServers: []};
  // These are the STUN services already offered by v13; LAN mode contacts none.
  const STUN = {iceServers: [{urls: 'stun:stun.cloudflare.com:3478'},
    {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.nextcloud.com:443'}]};
  const S = {pairing: 'direct', role: null, stage: 'idle', attempt: 0,
    pc: null, dc: null, directRescueRound: 0, timers: []};
  const hooks = {onConnected: null, onFailed: null, onMessage: null, onClosed: null};
  const history = [];
  function notify(name, detail) { window.dispatchEvent(new CustomEvent(name, {detail})); }
  function log(message) {
    history.push('[' + new Date().toLocaleTimeString() + '] ' + message);
    if (history.length > 80) history.shift();
    const el = $('log');
    if (el) { el.textContent = history.join('\n'); el.scrollTop = el.scrollHeight; }
    notify('beamsync-diagnostics', history.join('\n'));
  }
  function show(id, visible = true) { $(id)?.classList.toggle('hidden', !visible); }
  function writeStatus(id, message, kind) {
    const el = $(id);
    if (el) { el.className = 'status ' + kind; el.textContent = message; }
  }
  function status(message, kind = '') {
    writeStatus('status', message, kind); log(message); notify('beamsync-status', {message,kind});
  }
  function progress(message, kind = 'subtle') { writeStatus('pairProgress', message, kind); }
  function addTimer(fn, ms) {
    const t = setTimeout(() => { S.timers = S.timers.filter(x => x !== t); fn(); }, ms);
    S.timers.push(t); return t;
  }
  function clearTimers() { S.timers.forEach(clearTimeout); S.timers = []; }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    for (const [size, unit] of [[1073741824,'GiB'],[1048576,'MiB'],[1024,'KiB']])
      if (n >= size) return (n/size).toFixed(size === 1073741824 ? 2 : 1) + ' ' + unit;
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2,'0')).join(''); }
  function randId(n = 10) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
  function b64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i,i+32768));
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function unb64u(s) {
    const raw = atob(s.replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(raw, ch => ch.charCodeAt(0));
  }
  function beginAttempt() { clearTimers(); S.directRescueRound = 0; return ++S.attempt; }
  function hardClose() {
    clearTimers(); const {pc,dc} = S; S.dc = null; S.pc = null;
    if (dc) { dc.onopen = dc.onclose = dc.onmessage = dc.onerror = null; try {dc.close();} catch {} }
    if (pc) { try {pc.close();} catch {} }
  }
  function wireChannel(channel) {
    if (S.dc && S.dc !== channel || !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
      channel.close(); return;
    }
    S.dc = channel; channel.binaryType = 'arraybuffer';
    channel.onopen = () => { if (S.dc === channel) hooks.onConnected?.(); };
    channel.onclose = () => { if (S.dc === channel) { log('Data channel closed'); hooks.onClosed?.(); } };
    channel.onerror = () => { if (S.dc === channel) log('Data channel reported a transport error'); };
    channel.onmessage = e => { if (S.dc === channel) hooks.onMessage?.(e); };
  }
  function makePC(mode) {
    hardClose();
    if (!window.RTCPeerConnection) throw Error('This browser does not provide WebRTC. Open BeamSync in Safari or Chrome.');
    const assisted = mode === 'stun';
    const pc = new RTCPeerConnection(assisted ? STUN : LAN); S.pc = pc;
    const candidateTypes = new Set();
    log(assisted ? 'Checking local and public-STUN routes.' : 'Checking local routes on Wi-Fi or hotspot.');
    function routeHint() {
      if (!candidateTypes.size) return 'The browser reported no route. Check Wi-Fi access and try pairing again.';
      if (!assisted) return 'Use the same Wi-Fi or hotspot. For separate networks, choose Different networks on both devices.';
      if (!candidateTypes.has('srflx') && !candidateTypes.has('prflx'))
        return 'No public route was reported. Check internet access or switch both devices to the same hotspot.';
      return 'A direct route could not open. Isolated Wi-Fi and restrictive mobile networks may require a relay. Try the same hotspot.';
    }
    pc.ondatachannel = e => { if (S.pc === pc) wireChannel(e.channel); else e.channel.close(); };
    pc.onicecandidate = e => {
      if (S.pc !== pc || !e.candidate) return;
      const type = e.candidate.type || 'unspecified';
      candidateTypes.add(type); log('Route available: ' + type + '/' + (e.candidate.protocol || '?'));
    };
    pc.onicecandidateerror = e => { if (S.pc === pc) log('ICE server response ' + (e.errorCode || 'unavailable')); };
    pc.oniceconnectionstatechange = () => { if (S.pc === pc) log('ICE: ' + pc.iceConnectionState); };
    let disconnectedTimer;
    pc.onconnectionstatechange = () => {
      clearTimeout(disconnectedTimer);
      if (S.pc !== pc) return;
      log('Connection: ' + pc.connectionState);
      if (pc.connectionState === 'connected') pairStats();
      if (pc.connectionState === 'disconnected') {
        status('Connection interrupted. Keeping the session open for the network to return.', 'warn');
        disconnectedTimer = addTimer(() => { if (S.pc === pc && pc.connectionState === 'disconnected') hooks.onFailed?.(); }, 12000);
      } else if (pc.connectionState === 'failed') { log(routeHint()); hooks.onFailed?.(); }
    };
    return pc;
  }
  function waitIce(pc, ms = 10000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
        pc.removeEventListener('signalingstatechange', closed);
        if (pc.signalingState === 'closed' || S.pc !== pc) reject(Error('Pairing was cancelled.'));
        else resolve();
      };
      const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const closed = () => { if (pc.signalingState === 'closed') finish(); };
      pc.addEventListener('icegatheringstatechange', changed);
      pc.addEventListener('signalingstatechange', closed);
      timer = setTimeout(finish, ms);
    });
  }
  async function pairStats() {
    const pc = S.pc;
    try {
      const stats = await pc?.getStats(); if (!stats || pc !== S.pc) return;
      let pair, selected;
      stats.forEach(x => {
        if (x.type === 'transport' && x.selectedCandidatePairId) selected = x.selectedCandidatePairId;
        if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x;
      });
      pair = stats.get(selected) || pair;
      if (!pair) { log('Browser has not reported a selected route.'); return; }
      const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
      const route = (l?.candidateType || '?') + ' / ' + (l?.protocol || '?') + ' → ' + (r?.candidateType || '?') + ' / ' + (r?.protocol || '?');
      const rtt = Number.isFinite(pair.currentRoundTripTime) ? ' · ' + Math.round(pair.currentRoundTripTime * 1000) + ' ms round trip' : '';
      log('Selected route: ' + route + rtt);
      if ($('routeText')) $('routeText').textContent = 'WebRTC route: ' + route;
    } catch { log('Browser route statistics unavailable'); }
  }
  window.BeamSyncCore = {$,enc,dec,STUN,LAN,S,hooks,log,show,status,progress,addTimer,clearTimers,fmtBytes,
    randId,hex,b64u,unb64u,beginAttempt,hardClose,makePC,wireChannel,waitIce,pairStats};
})();
