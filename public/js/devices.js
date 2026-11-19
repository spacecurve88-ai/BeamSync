/* Optional device recognition over an already-open, ordered WebRTC channel. */
(() => {
  'use strict';

  const enc = new TextEncoder();
  const curve = { name: 'ECDSA', namedCurve: 'P-256' };
  const signature = { name: 'ECDSA', hash: 'SHA-256' };
  const peerPattern = /^[0-9a-f]{64}$/;
  const publicPattern = /^04[0-9a-f]{128}$/;
  const dbName = 'BeamSyncDeviceIdentity1';
  const maxRemembered = 50;

  function hex(value) {
    return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function bytes(value) {
    return Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
  }

  async function generateIdentity() {
    const pair = await crypto.subtle.generateKey(curve, false, ['sign', 'verify']);
    const publicHex = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { publicHex, privateKey: pair.privateKey };
  }

  function validateLabel(label) {
    if (typeof label !== 'string') throw Error('Enter a device name.');
    const clean = label.trim();
    if (!clean || clean.length > 48 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(clean)) {
      throw Error('Use a device name between 1 and 48 visible characters.');
    }
    return clean;
  }

  async function openStore(factory = globalThis.indexedDB) {
    if (!factory || !globalThis.crypto?.subtle) throw Error('This browser cannot save device identities.');
    const db = await new Promise((resolve, reject) => {
      const request = factory.open(dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('self');
        request.result.createObjectStore('peers', { keyPath: 'id' });
      };
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(Error('Close other BeamSync tabs, then try device recognition again.'));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (blocked) return request.result.close();
        resolve(request.result);
      };
    });
    db.onversionchange = () => db.close();

    function run(table, mode, issue) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(table, mode);
        let result;
        let fault;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(fault || tx.error || Error('Device storage is unavailable.'));
        issue(tx.objectStore(table), value => { result = value; }, error => { fault = error; tx.abort(); });
      });
    }

    function lookup(table, key) {
      return run(table, 'readonly', (s, done) => {
        const req = s.get(key);
        req.onsuccess = () => done(req.result);
      });
    }

    function checkPeerId(id) {
      if (typeof id !== 'string' || !peerPattern.test(id)) throw Error('Invalid device identity.');
      return id;
    }

    return {
      async identity() {
        const old = await lookup('self', 'identity');
        if (old) return old;
        // Generate outside IndexedDB's short-lived transaction. Concurrent tabs
        // select the first committed key inside the serialized write below.
        const candidate = await generateIdentity();
        return run('self', 'readwrite', (s, done) => {
          const req = s.get('identity');
          req.onsuccess = () => {
            if (!req.result) s.add(candidate, 'identity');
            done(req.result || candidate);
          };
        });
      },
      get(id) { return lookup('peers', checkPeerId(id)); },
      list() {
        return run('peers', 'readonly', (s, done) => {
          const req = s.getAll();
          req.onsuccess = () => done(req.result.sort((a, b) => b.lastSeen - a.lastSeen));
        });
      },
      save(id, label) {
        checkPeerId(id);
        const record = { id, label: validateLabel(label), lastSeen: Date.now() };
        return run('peers', 'readwrite', (s, done, fail) => {
          const req = s.get(id);
          req.onsuccess = () => {
            if (req.result) { s.put(record); done(record); return; }
            const count = s.count();
            count.onsuccess = () => {
              if (count.result >= maxRemembered) return fail(Error('Forget a saved device to make room for another.'));
              s.add(record);
              done(record);
            };
          };
        });
      },
      touch(id) {
        checkPeerId(id);
        return run('peers', 'readwrite', (s, done) => {
          const req = s.get(id);
          req.onsuccess = () => {
            if (!req.result) return;
            const record = { ...req.result, lastSeen: Date.now() };
            s.put(record);
            done(record);
          };
        });
      },
      forget(id) {
        checkPeerId(id);
        return run('peers', 'readwrite', s => s.delete(id));
      },
      close() { db.close(); }
    };
  }

  // Bind the proof to the fingerprint negotiated for SCTP. An unrelated media
  // section, an ambiguous description or an unsupported hash fails closed.
  function dtlsFingerprint(desc) {
    const sections = String(desc?.sdp || '').split(/(?:\r?\n)(?=m=)/);
    const data = sections.slice(1).filter(s => /^m=application (?!0 )\d+ \S*SCTP\S* /i.test(s));
    if (data.length !== 1) throw Error('Cannot verify the data channel on this browser.');
    const matches = part => Array.from(part.matchAll(/^a=fingerprint:sha-256 ([0-9a-f:]+)\r?$/gim), m => m[1]);
    const fingerprints = /^a=fingerprint:/im.test(data[0]) ? matches(data[0]) : matches(sections[0]);
    if (fingerprints.length !== 1 || !/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(fingerprints[0])) {
      throw Error('Cannot verify the connection fingerprint.');
    }
    return fingerprints[0].replace(/:/g, '').toLowerCase();
  }

  function createSession({ pc, send, store, expectedId = null, onChange = () => {} }) {
    if (expectedId !== null && (typeof expectedId !== 'string' || !peerPattern.test(expectedId))) {
      throw Error('Invalid saved device.');
    }
    let me = null, peer = null, incomingProof = null;
    let identity, localRole, binding, peerId, peerKey, startPromise, work = Promise.resolve();
    let helloSent = false, proofSent = false, proofSeen = false, helloSeen = false, closed = false;
    let state = { status: 'idle', code: '', peerId: '', label: '', message: '' };
    function change(status, patch = {}) {
      if (closed && status !== 'closed') return;
      if (state.status === status && Object.keys(patch).length === 0) return;
      state = { ...state, status, ...patch };
      onChange({ ...state });
    }
    function schedule(action) {
      const result = work.then(async () => {
        if (closed || state.status === 'failed' || state.status === 'mismatch') return;
        await action();
      });
      work = result.catch(error => {
        if (!closed) change('failed', { code: '', message: String(error?.message || 'Device verification failed.') });
      });
      return work;
    }
    function transcript(purpose) {
      const [offer, answer] = localRole === 'offer' ? [me, peer] : [peer, me];
      return enc.encode(JSON.stringify(['BeamSync device proof v1', purpose, ...binding,
        offer.key, offer.nonce, answer.key, answer.nonce]));
    }
    function write(frame) { if (!closed) send({ t: 'device-v1', ...frame }); }
    async function advance() {
      if (closed || !peer) return;
      if (!me) { change('requested'); return; }
      if (!peerKey) {
        peerId = hex(await crypto.subtle.digest('SHA-256', bytes(peer.key)));
        if (expectedId && expectedId !== peerId) {
          change('mismatch', { message: 'The connected browser has a different identity than the saved device.' });
          return;
        }
        if (peer.key === me.key || me.nonce === peer.nonce) throw Error('This browser cannot verify itself.');
        peerKey = await crypto.subtle.importKey('raw', bytes(peer.key), curve, false, ['verify']);
      }
      if (!proofSent) {
        change('verifying');
        const proof = await crypto.subtle.sign(signature, identity.privateKey, transcript(localRole));
        if (closed) return;
        proofSent = true;
        write({ type: 'proof', sig: hex(proof) });
      }
      if (!incomingProof) return;
      const otherRole = localRole === 'offer' ? 'answer' : 'offer';
      const valid = await crypto.subtle.verify(signature, peerKey, bytes(incomingProof), transcript(otherRole));
      if (!valid) throw Error('The device did not pass verification. Pair again.');
      incomingProof = null;
      const digest = hex(await crypto.subtle.digest('SHA-256', transcript('comparison')));
      const code = digest.slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');
      if (closed) return;
      const record = await store.touch(peerId);
      if (closed) return;
      if (expectedId && !record) {
        change('mismatch', { message: 'This device is no longer remembered on this browser.' });
        return;
      }
      change(record ? 'trusted' : 'new', { code, peerId, label: record?.label || '' });
    }
    return {
      get state() { return { ...state }; },
      start() {
        if (startPromise) return startPromise;
        startPromise = schedule(async () => {
          const local = pc.localDescription, remote = pc.remoteDescription;
          localRole = local?.type;
          if (!['offer','answer'].includes(localRole) || remote?.type !== (localRole === 'offer' ? 'answer' : 'offer')) {
            throw Error('Connect the browsers before verifying a device.');
          }
          binding = (localRole === 'offer' ? [local, remote] : [remote, local]).map(dtlsFingerprint);
          if (binding[0] === binding[1]) throw Error('The connection fingerprints must be different.');
          identity = await store.identity();
          if (closed) return;
          me = { key: identity.publicHex, nonce: hex(crypto.getRandomValues(new Uint8Array(32))) };
          if (!publicPattern.test(me.key) || identity.privateKey?.extractable !== false) throw Error('Device identity is unavailable.');
          change('waiting');
          helloSent = true;
          write({ type: 'hello', ...me });
          await advance();
        });
        return startPromise;
      },
      receive(frame) {
        if (closed || frame?.t !== 'device-v1' || ['failed','mismatch','trusted','new'].includes(state.status)) return Promise.resolve();
        // Reserve at most one slot per frame type, before any asynchronous crypto.
        if (frame.type === 'hello' && !helloSeen) {
          helloSeen = true;
          if (typeof frame.key !== 'string' || !publicPattern.test(frame.key) ||
              typeof frame.nonce !== 'string' || !peerPattern.test(frame.nonce)) {
            return schedule(() => { throw Error('Invalid device verification request.'); });
          }
          const hello = { key: frame.key, nonce: frame.nonce };
          return schedule(async () => { peer = hello; await advance(); });
        }
        if (frame.type === 'proof' && !proofSeen && helloSeen && helloSent) {
          proofSeen = true;
          if (typeof frame.sig !== 'string' || !/^[0-9a-f]{128}$/.test(frame.sig)) {
            return schedule(() => { throw Error('Invalid device proof.'); });
          }
          const proof = frame.sig;
          return schedule(async () => { incomingProof = proof; await advance(); });
        }
        return Promise.resolve();
      },
      async remember(label, comparedCode) {
        if (closed || state.status !== 'new' || comparedCode !== state.code) {
          throw Error('Compare the same code on both screens before remembering this browser.');
        }
        const record = await store.save(peerId, validateLabel(label));
        if (!closed) change('trusted', { label: record.label });
        return record;
      },
      close() {
        closed = true; me = peer = identity = peerKey = incomingProof = null;
        change('closed', { code: '', peerId: '', label: '', message: '' });
      }
    };
  }
  globalThis.BeamSyncDevices = Object.freeze({ openStore, createSession });
})();
