(() => {
  'use strict';
  const C = window.BeamSyncCore, signal = window.BeamSyncSignal;
  const enabled = signal.enabled === true;
  let startupInvite = signal.takeInvite();
  const forgetTimer = startupInvite ? setTimeout(forgetInvite, 180000) : null;
  function forgetInvite() { startupInvite = null; if (forgetTimer) clearTimeout(forgetTimer); }
  let current = null;
  function reset() {
    const session = current;
    forgetInvite();
    if (!session) return;
    current = null;
    session.abort.abort();
    session.cancelOpen?.();
    if (session.timer) clearTimeout(session.timer);
    if (session.invite) void session.invite.close();
    // Normal global reset also disposes of the channel. Calling reset() alone is safe.
    if (C.S.pc === session.pc) { C.beginAttempt(); C.hardClose(); C.S.stage = 'idle'; C.S.role = null; }
  }
  function begin(role, options) {
    if (!enabled) throw Error('One-scan pairing is unavailable here. Use offline QR.');
    if (!window.crypto?.subtle || !window.RTCPeerConnection) throw Error('This browser cannot start secure one-scan pairing.');
    if (navigator.onLine === false) throw Error('Use offline QR while the internet is unavailable.');
    if (current || C.S.stage !== 'idle') throw Error('Finish or reset the current connection first.');
    C.beginAttempt();
    C.S.pairing = 'quick';
    C.S.role = role;
    C.S.stage = 'quick-pairing';
    let pc;
    try { pc = C.makePC(options.network === 'stun' ? 'stun' : 'lan'); }
    catch (error) { C.S.stage = 'idle'; C.S.role = null; throw error; }
    const session = {abort:new AbortController(), pc, invite:null, timer:null, attempt:C.S.attempt,
      onStatus:options.onStatus || (() => {})};
    current = session;
    return session;
  }
  function live(session) {
    if (current !== session || session.abort.signal.aborted || C.S.pc !== session.pc || C.S.attempt !== session.attempt)
      throw new DOMException('Pairing cancelled.', 'AbortError');
  }
  // DataChannel open may arrive before or after HTTP acknowledgment. Keep both paths independent.
  function watchOpen(session) {
    const finish = () => {
      if (current !== session) return;
      if (session.invite) { void session.invite.close(); session.invite = null; }
      clearTimeout(session.timer);
      session.cancelOpen?.();
      current = null;
    };
    const channel = c => {
      if (c.readyState === 'open') { finish(); return; }
      c.addEventListener('open', finish, {once:true});
      session.cancelOpen = () => {
        c.removeEventListener('open', finish);
        session.pc.removeEventListener('datachannel', incoming);
      };
    };
    const incoming = e => channel(e.channel);
    session.cancelOpen = () => session.pc.removeEventListener('datachannel', incoming);
    session.pc.addEventListener('datachannel', incoming, {once:true});
    session.timer = setTimeout(() => {
      if (current !== session) return;
      reset();
      session.onStatus('The direct route did not open. Reconnect on the same Wi-Fi or hotspot, or select cross-network routing.');
    }, 25000);
    if (C.S.dc) channel(C.S.dc);
  }
  async function start(options = {}) {
    const session = begin('A', options), pc = session.pc;
    try {
      session.onStatus('Preparing your private invitation…');
      C.wireChannel(pc.createDataChannel('beamsync-v14', {ordered:true}));
      const offer = await pc.createOffer(); live(session);
      await pc.setLocalDescription(offer); live(session);
      await C.waitIce(pc); live(session);
      session.invite = await signal.create(pc.localDescription, {signal:session.abort.signal});
      if (current !== session) { void session.invite.close(); live(session); }
      options.onInvite?.(session.invite.url, session.invite.expiresAt);
      session.onStatus('Waiting for the other device to join…');
      const answer = await session.invite.waitAnswer(); live(session);
      await pc.setRemoteDescription(answer); live(session);
      // Answer has now been authenticated and applied. Remove the mailbox immediately.
      void session.invite.close(); session.invite = null;
      session.onStatus('Opening the direct connection…');
      watchOpen(session);
    } catch (error) {
      if (current === session) reset();
      throw error;
    }
  }
  async function join(url, options = {}) {
    if (!signal.isInvite(url)) throw Error('That is not a BeamSync invite for this site.');
    const session = begin('B', options), pc = session.pc;
    if (url === startupInvite) forgetInvite();
    try {
      session.onStatus('Verifying the encrypted invitation…');
      const remote = await signal.join(url, {signal:session.abort.signal}); live(session);
      await pc.setRemoteDescription(remote.offer); live(session);
      const answer = await pc.createAnswer(); live(session);
      await pc.setLocalDescription(answer); live(session);
      await C.waitIce(pc); live(session);
      try { await remote.reply(pc.localDescription); }
      catch (error) {
        // A lost HTTP acknowledgement can arrive after the host already applied our answer and erased the room.
        if (C.S.dc?.readyState !== 'open' || C.S.pc !== pc) throw error;
      }
      live(session);
      session.onStatus('Opening the direct connection…');
      watchOpen(session);
    } catch (error) {
      if (current === session) reset();
      throw error;
    }
  }
  window.BeamSyncQuick = Object.freeze({start, join, reset, enabled, get startupInvite() { return startupInvite; }});
})();
