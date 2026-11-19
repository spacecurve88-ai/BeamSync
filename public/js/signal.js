/* Ephemeral signaling for an ordered WebRTC data channel. All file bytes use WebRTC. */
(() => {
  'use strict';
  // This trial is restricted to the exact HTTPS draft host, including direct client API calls.
  const enabled = location.protocol === 'https:' && location.host === 'beamsync-draft.hatchable.site'
    && document.querySelector('meta[name="beamsync-one-scan"]')?.content === 'enabled';
  const endpoint = '/api/quick-pair';
  function requireTrial() {
    if (!enabled) throw Error('One-scan pairing is unavailable here. Use offline QR.');
  }
  const ttl = 180000;
  const maxSDP = 49152;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const pattern = /^#bs14=([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

  function base64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192)
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function unbase64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
      throw Error('Invalid pairing data.');
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (base64(bytes) !== value) throw Error('Invalid pairing data.');
    return bytes;
  }
  const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  const fresh = size => crypto.getRandomValues(new Uint8Array(size));
  const digest = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));

  function parseInvite(text) {
    if (typeof text !== 'string' || text.length > 1024) throw Error('Invalid BeamSync invite.');
    const url = new URL(text);
    const match = pattern.exec(url.hash);
    if (!match || url.origin !== location.origin || url.pathname !== '/' || url.search ||
        url.username || url.password || unbase64(match[2]).length !== 32) throw Error('Invalid BeamSync invite.');
    return {room: match[1], secret: match[2]};
  }
  function isInvite(text) {
    try { parseInvite(text); return true; } catch { return false; }
  }
  function takeInvite() {
    if (!location.hash.startsWith('#bs14=')) return null;
    // Preserve legitimate local query state in history, never copy it to a pairing QR.
    const candidate = location.origin + '/' + location.hash;
    history.replaceState(history.state, '', location.pathname + location.search);
    return enabled && isInvite(candidate) ? candidate : null;
  }
  function validate(description, kind) {
    const s = description?.sdp;
    if (description?.type !== kind || typeof s !== 'string' || s.length > maxSDP ||
        !/^v=0\r?\n/.test(s) || !/^a=fingerprint:sha-256 /im.test(s) ||
        !/^m=application .*\bwebrtc-datachannel\b/im.test(s) ||
        s.split(/\r?\n/).some(line => line.startsWith('m=') && !line.startsWith('m=application ')) ||
        encoder.encode(s).length > maxSDP) throw Error('Invalid BeamSync data-channel handshake.');
    return {type: kind, sdp: s};
  }
  async function keys(room, secret) {
    const key = await crypto.subtle.importKey('raw', unbase64(secret), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
    // The server sees a derivative of the random QR secret. It never receives the encryption key.
    const guest = await digest('BeamSync guest v1/' + room + '/' + secret);
    return {room, key, guest};
  }
  const aad = (room, kind) => encoder.encode('BeamSync/14/' + room + '/' + kind);
  async function seal(ctx, description, kind) {
    const bytes = encoder.encode(validate(description, kind).sdp);
    const iv = fresh(12);
    const cipher = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:aad(ctx.room, kind)}, ctx.key, bytes);
    return base64(iv) + '.' + base64(new Uint8Array(cipher));
  }
  async function open(ctx, envelope, kind) {
    if (typeof envelope !== 'string' || envelope.length > 65600 ||
        !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(envelope)) throw Error('Invalid pairing envelope.');
    const [iv, data] = envelope.split('.').map(unbase64);
    try {
      const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv, additionalData:aad(ctx.room, kind)}, ctx.key, data);
      return validate({type: kind, sdp:decoder.decode(plain)}, kind);
    } catch { throw Error('The encrypted handshake could not be verified. Create a new invite.'); }
  }
  function stopped() { return new DOMException('Pairing cancelled.', 'AbortError'); }
  function wait(ms, signal) {
    if (signal?.aborted) return Promise.reject(stopped());
    return new Promise((resolve,reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(stopped()); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', cancel, {once:true});
    });
  }
  class SignalError extends Error {
    constructor(code) {
      const messages = {400:'Invalid pairing request.', 403:'Pairing access denied.', 404:'Invite unavailable or expired.',
        409:'This invitation is in use. Create a fresh invite.', 429:'Pairing is busy. Try again shortly.'};
      super(messages[code] || 'The pairing service is unavailable. You can use offline QR.');
      this.code = code;
    }
  }
  async function post(body, signal) {
    if (signal?.aborted) throw stopped();
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    signal?.addEventListener('abort', cancel, {once:true});
    const timer = setTimeout(cancel, 8000);
    try {
      const response = await fetch(endpoint, {method:'POST', cache:'no-store', credentials:'same-origin',
        referrerPolicy:'no-referrer', redirect:'error', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:ctl.signal});
      if (!response.ok) throw new SignalError(response.status);
      if (!response.headers.get('content-type')?.includes('application/json')) throw new SignalError(403);
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw stopped();
      if (error instanceof SignalError) throw error;
      throw new SignalError(503);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  async function request(body, signal) {
    // Retransmit the same envelope after a lost response. Never replace another answer.
    try { return await post(body, signal); }
    catch (error) {
      if (!(error.code >= 500)) throw error;
      await wait(500, signal);
      return post(body, signal);
    }
  }
  async function create(offer, {signal} = {}) {
    requireTrial();
    validate(offer, 'offer');
    for (let attempt = 0; attempt < 4; attempt++) {
      const secret = base64(fresh(32)), owner = hex(fresh(32));
      const room = (await digest('BeamSync room v1/' + owner)).slice(0, 32);
      const ctx = await keys(room, secret);
      const box = await seal(ctx, offer, 'offer');
      let receipt;
      try { receipt = await request({op:'create', room, owner, guestHash:await digest(ctx.guest), box}, signal); }
      catch (error) {
        if (error.code === 409 && attempt < 3) continue;
        // The server might already have committed an offer whose reply was lost.
        if (signal?.aborted || error.code >= 500) void post({op:'close', room, token:owner}).catch(() => {});
        throw error;
      }
      const expiresAt = Date.now() + Math.max(0, Math.min(ttl, Number(receipt.remainingMs) || 0));
      const url = location.origin + '/#bs14=' + room + '.' + secret;
      const close = () => request({op:'close', room, token:owner}).catch(() => {});
      async function waitAnswer() {
        let delay = 750;
        while (Date.now() < expiresAt) {
          try {
            const {box:answer} = await post({op:'poll', room, token:owner}, signal);
            if (answer) return open(ctx, answer, 'answer');
          } catch (error) {
            if (!(error.code >= 500 || error.code === 429)) throw error;
          }
          await wait(Math.min(delay, Math.max(0, expiresAt - Date.now())), signal);
          delay = Math.min(3500, Math.ceil(delay * 1.4));
        }
        throw Error('This pairing invite expired. Create a new invite.');
      }
      return {url, expiresAt, waitAnswer, close};
    }
  }
  async function join(inviteURL, {signal} = {}) {
    requireTrial();
    const {room, secret} = parseInvite(inviteURL);
    const ctx = await keys(room, secret);
    const {box} = await request({op:'offer', room, token:ctx.guest}, signal);
    const offer = await open(ctx, box, 'offer');
    let replySDP, sealing;
    async function reply(answer) {
      const description = validate(answer, 'answer');
      if (sealing && description.sdp !== replySDP) throw Error('This invitation already has an answer.');
      if (!sealing) {
        replySDP = description.sdp;
        sealing = seal(ctx, description, 'answer');
      }
      await request({op:'answer', room, token:ctx.guest, box:await sealing}, signal);
    }
    return {offer, reply};
  }
  window.BeamSyncSignal = Object.freeze({create, join, isInvite, takeInvite, enabled});
})();
