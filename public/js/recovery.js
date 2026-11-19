// BeamSync receiver storage. Call open only after accepting the file offer.
(() => {
  'use strict';
  const DB_NAME = 'beamsync-recovery-v14';
  const TABLES = ['files','blocks','leases'];
  const BLOCK = 1024 * 1024;
  const MAX_FILE = 250 * BLOCK;
  const MAX_TOTAL = 500 * BLOCK;
  const RAM_LIMIT = 32 * BLOCK;
  const MAX_ITEMS = 16;
  const TTL = 24 * 60 * 60 * 1000;
  const LEASE = 45000;
  const HEX = /^[0-9a-f]{64}$/;
  let dbPromise, memoryReserved = 0;

  function database() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        let late = false;
        const timer = setTimeout(() => {
          late = true;
          reject(Error('Browser storage did not open.'));
        }, 8000);
        req.onupgradeneeded = event => {
          const db = req.result;
          if (event.oldVersion === 0) {
            db.createObjectStore('files', {keyPath:'key'});
            db.createObjectStore('blocks', {keyPath:['key','at']});
          }
          const leases = db.createObjectStore('leases', {keyPath:'key'});
          if (event.oldVersion === 1) {
            // Preserve every staged file and block from the first preview.
            const old = req.transaction.objectStore('files').getAll();
            old.onsuccess = () => {
              for (const row of old.result) if (row.owner) leases.add({key:row.key,owner:row.owner});
            };
          }
        };
        req.onerror = () => {clearTimeout(timer); reject(req.error);};
        req.onsuccess = () => {
          clearTimeout(timer);
          const db = req.result;
          if (late) {db.close(); return;}
          db.onversionchange = () => {db.close(); dbPromise = undefined;};
          db.onclose = () => {dbPromise = undefined;};
          resolve(db);
        };
      }).catch(error => {dbPromise = undefined; throw error;});
    }
    return dbPromise;
  }

  function transaction(db, stores, mode, body) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(stores, mode, mode === 'readwrite' ? {durability:'strict'} : {});
      } catch {
        tx = db.transaction(stores, mode);
      }
      let value, failure;
      const set = result => {value = result;};
      const fail = error => {
        failure = error;
        try {tx.abort();} catch {}
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure || tx.error || Error('Browser storage operation was interrupted.'));
      try {body(tx, set, fail);} catch (error) {fail(error);}
    });
  }

  function remove(tx, key) {
    tx.objectStore('leases').delete(key);
    tx.objectStore('files').delete(key);
    const range = IDBKeyRange.bound([key,0], [key,Number.MAX_SAFE_INTEGER]);
    tx.objectStore('blocks').delete(range);
  }

  function isActive(row, now) {
    return Boolean(row.owner && row.leaseUntil > now);
  }

  function expired(row, now) {
    return !isActive(row, now) && (!row.resumable || row.expiresAt <= now || !row.offset);
  }

  function liveRows(tx, done) {
    const files = tx.objectStore('files').getAll();
    const leases = tx.objectStore('leases').getAll();
    leases.onsuccess = () => {
      const owners = new Map(leases.result.map(lease => [lease.key,lease.owner]));
      const now = Date.now(), live = [];
      for (const row of files.result) {
        // A separate deletable lease lets an interrupted writer release its
        // claim even if quota pressure prevents every insert and update.
        if (owners.get(row.key) !== row.owner) row.owner = '';
        if (expired(row, now)) remove(tx, row.key);
        else live.push(row);
      }
      done(live);
    };
  }

  async function sweep(db) {
    return transaction(db, TABLES, 'readwrite', (tx,set) => liveRows(tx,set));
  }

  async function prune() {await sweep(await database());}

  async function list() {
    const rows = await sweep(await database());
    return rows.filter(row => row.resumable && row.offset > 0)
      .map(({key,name,size,offset,expiresAt,owner,leaseUntil}) => ({
        key,name,size,offset,expiresAt,active:isActive({owner,leaseUntil}, Date.now())
      }));
  }

  async function forget(key) {
    if (typeof key !== 'string' || !key.startsWith('resume:')) throw Error('Invalid checkpoint.');
    return transaction(await database(), TABLES, 'readwrite', (tx,set,fail) => {
      liveRows(tx, rows => {
        const row = rows.find(item => item.key === key);
        if (!row) return;
        if (isActive(row, Date.now())) return fail(Error('Stop the active transfer before removing its checkpoint.'));
        remove(tx,key);
      });
    });
  }

  function owned(db, key, owner, body) {
    return transaction(db, TABLES, 'readwrite', (tx,set,fail) => {
      const files = tx.objectStore('files'), read = files.get(key);
      const lease = tx.objectStore('leases').get(key);
      lease.onsuccess = () => {
        if (read.result?.owner !== owner || lease.result?.owner !== owner)
          return fail(Error('Checkpoint is in use or was removed.'));
        try {body(tx, read.result, files, set, fail);} catch (error) {fail(error);}
      };
    });
  }

  async function freeEstimate() {
    try {
      const est = await navigator.storage?.estimate?.();
      if (Number.isFinite(est?.quota) && Number.isFinite(est?.usage)) return Math.max(0, est.quota - est.usage);
    } catch {}
    return Infinity;
  }

  function claim(db, fresh, free) {
    return transaction(db, TABLES, 'readwrite', (tx,set,fail) => {
      liveRows(tx, rows => {
        const now = Date.now();
        const old = rows.find(row => row.key === fresh.key);
        if (old && isActive(old,now)) return fail(Error('Another tab is receiving this file. After a closed tab, retry in 45 seconds.'));
        if (!old && (rows.length >= MAX_ITEMS || rows.reduce((sum,row) => sum+row.size, fresh.size) > MAX_TOTAL))
          return fail(Error('Checkpoint storage is full. Remove an interrupted transfer and retry.'));
        const offset = old?.offset || 0;
        if (fresh.size-offset > free) return fail(Error('The browser reports too little free space for this file.'));
        const row = {...fresh, offset};
        tx.objectStore('files').put(row);
        tx.objectStore('leases').put({key:row.key,owner:row.owner});
        set(row);
      });
    });
  }

  async function digest(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const hex = Array.from(hash, v => v.toString(16).padStart(2,'0')).join('');
    return {bytes,hex};
  }

  function cancelIfNeeded(signal) {
    if (signal?.aborted) throw new DOMException('Transfer stopped.', 'AbortError');
  }

  async function open(meta, {resumable = false, peer = '', onPrefix = () => {}, signal} = {}) {
    cancelIfNeeded(signal);
    if (!meta || typeof meta.sha256 !== 'string' || !HEX.test(meta.sha256) || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_FILE ||
        typeof peer !== 'string' || peer.length > 160 || typeof onPrefix !== 'function') throw Error('Invalid checkpoint metadata.');
    const owner = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
    const key = resumable ? 'resume:' + meta.sha256 + ':' + meta.size + ':' + peer : 'temp:' + owner;
    const name = String(meta.name || 'received.bin').slice(0,240);
    const type = 'application/octet-stream';
    const size = meta.size;
    let db;
    try {db = await database();} catch {}
    cancelIfNeeded(signal);
    let offset = 0;
    if (db) {
      const now = Date.now();
      const free = await freeEstimate();
      const record = await claim(db, {key,name,size,resumable,owner,leaseUntil:now+LEASE,expiresAt:now+TTL}, free);
      offset = record.offset;
    } else {
      if (size + memoryReserved > RAM_LIMIT) throw Error('Browser storage is unavailable. Memory-only transfers are limited to 32 MiB in total.');
      memoryReserved += size;
    }
    const memory = [];
    let closed = false, serial = Promise.resolve(), leaseTimer;
    const queue = operation => {
      const next = serial.then(operation);
      serial = next.catch(() => {});
      return next;
    };
    const offsetSize = at => Math.min(BLOCK, size-at);

    async function readBlock(at) {
      if (!db) return memory[at/BLOCK];
      return transaction(db, ['blocks'], 'readonly', (tx,set) => {
        const req = tx.objectStore('blocks').get([key,at]);
        req.onsuccess = () => set(req.result);
      });
    }

    async function verified(at) {
      const block = await readBlock(at);
      if (!block || !(block.blob instanceof Blob) || block.blob.size !== offsetSize(at) || !HEX.test(block.sha256))
        throw Error('The saved checkpoint is incomplete. Send this file again.');
      const {bytes,hex} = await digest(block.blob);
      if (block.sha256 !== hex) throw Error('The saved checkpoint failed verification. Send this file again.');
      return {bytes,blob:block.blob};
    }

    // Storage can temporarily refuse to read an intact Blob. Keep previously
    // committed blocks for an opted-in retry. Structural and digest failures
    // are ordinary Errors from verified() and invalidate the saved transfer.
    const shouldRetain = error => {
      if (signal?.reason === 'beamsync-discard') return false;
      if (error?.name === 'AbortError') return true;
      return error instanceof DOMException &&
        ['QuotaExceededError','NotReadableError','UnknownError','NotFoundError'].includes(error.name);
    };
    const onAbort = () => {
      const operation = signal.reason === 'beamsync-discard' ? discard : interrupt;
      operation().catch(() => {});
    };
    async function close(retain) {
      if (closed) return;
      try {
        if (db) {
          await owned(db,key,owner,(tx,row) => {
            if (retain && resumable && row.offset) tx.objectStore('leases').delete(key);
            else remove(tx,key);
          });
        }
      } finally {
        clearInterval(leaseTimer);
        signal?.removeEventListener('abort',onAbort);
        memory.length = 0;
        if (!db) memoryReserved -= size;
        closed = true;
      }
    }

    const interrupt = () => queue(() => close(true));
    const discard = () => queue(() => close(false));
    function check() {
      cancelIfNeeded(signal);
      if (closed) throw Error('The receiver storage is closed.');
    }

    if (db) {
      leaseTimer = setInterval(() => {
        if (closed) return;
        owned(db,key,owner,(tx,row,files) => {
          row.leaseUntil = Date.now()+LEASE;
          files.put(row);
        }).catch(() => {});
      }, LEASE/3);
    }

    // Reject the entire old checkpoint on corruption. The application can re-offer the file.
    try {
      check();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || (offset !== size && offset % BLOCK))
        throw Error('The saved checkpoint offset is invalid. Send this file again.');
      for (let at = 0; at < offset; at += BLOCK) {
        const {bytes} = await verified(at);
        check();
        onPrefix(bytes);
      }
      check();
      signal?.addEventListener('abort',onAbort,{once:true});
    } catch (error) {
      await close(shouldRetain(error));
      throw error;
    }

    function append(data, expected) {
      return queue(async () => {
        check();
        const blob = data instanceof Blob ? data : new Blob([data]);
        if (!blob.size || blob.size !== offsetSize(offset)) throw Error('Invalid checkpoint block length.');
        const {hex} = await digest(blob);
        check();
        if (expected !== undefined && expected !== hex) throw Error('The received checkpoint failed verification.');
        const end = offset + blob.size;
        const block = {key,at:offset,sha256:hex,blob};
        if (db) {
          await owned(db,key,owner,(tx,row,files) => {
            if (row.offset !== offset) throw Error('Checkpoint offset changed.');
            tx.objectStore('blocks').add(block);
            row.offset = end;
            row.leaseUntil = Date.now()+LEASE;
            row.expiresAt = Date.now()+TTL;
            files.put(row);
          });
        } else memory.push(block);
        offset = end;
        return hex;
      });
    }

    function finish() {
      return queue(async () => {
        check();
        if (offset !== size) throw Error('The file is incomplete.');
        const parts = [];
        try {
          for (let at = 0; at < size; at += BLOCK) {
            check();
            parts.push((await verified(at)).blob);
          }
          check();
          const result = new Blob(parts,{type});
          if (result.size !== size) throw Error('The saved file size changed.');
          await close(false);
          return result;
        } catch (error) {
          await close(shouldRetain(error));
          throw error;
        }
      });
    }

    return {get offset() {return offset;}, resumable:Boolean(resumable && db), key, append, finish, interrupt, discard};
  }

  window.BeamSyncRecovery = {open,list,forget,prune,BLOCK,TTL};
})();
