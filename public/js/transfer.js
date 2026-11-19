(() => {
  'use strict';
  const { $, S, hooks, fmtBytes, randId } = window.BeamSyncCore;
  const BLOCK = 1024 * 1024, MAX_FILE = 250 * BLOCK, MAX_TOTAL = 500 * BLOCK;
  const FRAME = 16 * 1024, MAX_CONTROL = 65536, STALL = 120000;
  const DIGEST = /^[a-f0-9]{64}$/, NONCE = /^[a-f0-9]{32}$/, ID = /^[a-zA-Z0-9_-]{1,64}$/;
  let active = null;
  const downloads = [];

  function emit(type, fields = {}) {
    window.dispatchEvent(new CustomEvent('beamsync-transfer', { detail: { type, ...fields } }));
  }
  function label(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.className = 'status ' + cls;
  }
  function visible(id, on) { $(id)?.classList.toggle('hidden', !on); }
  function state(direction, value, message) {
    label(direction + 'Status', message, ({success:'ok',error:'err',idle:'subtle'})[value] || 'warn');
    emit('status', {direction, state:value, message});
  }
  function progress(job, file, bytes) {
    const totalBytes = job.doneBytes + bytes;
    const now = performance.now();
    if (job.sample?.file !== file) job.sample = {file,bytes,time:now,rate:0};
    const sample = job.sample, elapsed = (now-sample.time)/1000;
    if (elapsed >= 0.25 && bytes > sample.bytes) {
      const measured = (bytes-sample.bytes)/elapsed;
      sample.rate = sample.rate ? sample.rate*0.65+measured*0.35 : measured;
      sample.time = now;
      sample.bytes = bytes;
    }
    const rate = sample.rate, eta = rate ? Math.ceil((job.total-totalBytes)/rate) : null;
    const bar = $(job.direction + 'Bar');
    if (bar) bar.style.width = (job.total ? totalBytes * 100 / job.total : 100) + '%';
    label(job.direction + 'Status', file.name + ' · ' + fmtBytes(bytes) + ' of ' + fmtBytes(file.size) +
      (rate ? ' · '+fmtBytes(rate)+'/s · ~'+eta+'s left' : ''), 'warn');
    emit('progress',{direction:job.direction, name:file.name, bytes:totalBytes, total:job.total, fileBytes:bytes, fileSize:file.size, rate, eta});
  }
  function safeName(value) {
    if (typeof value !== 'string' || !value || value.length > 1024) throw Error('Invalid filename.');
    const leaf = value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim();
    return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0,240) : 'received.bin';
  }
  function mimeType(value) {
    if (typeof value !== 'string' || value.length > 120 || /[^\x20-\x7e]/.test(value)) throw Error('Invalid file type.');
    return value || 'application/octet-stream';
  }
  function plan(files, total, incoming) {
    if (!Array.isArray(files) || !files.length || files.length > 100) throw Error('Choose between 1 and 100 files.');
    let bytes = 0;
    const meta = files.map((file,i) => {
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE) throw Error('Each file must be 250 MiB or smaller.');
      if (incoming && file.id !== String(i)) throw Error('Invalid file sequence.');
      bytes += file.size;
      return {id:String(i),name:safeName(file.name),size:file.size,mime:mimeType(incoming ? file.mime : (file.type || 'application/octet-stream'))};
    });
    if (bytes > MAX_TOTAL || (incoming && total !== bytes)) throw Error('Invalid total or more than 500 MiB selected.');
    return {meta,total:bytes};
  }
  function rawSend(dc, data) {
    if (dc?.readyState !== 'open') throw Error('The devices disconnected.');
    dc.send(data);
  }
  function control(dc, message) {
    const text = JSON.stringify(message);
    const max = Math.min(MAX_CONTROL, S.pc?.sctp?.maxMessageSize || MAX_CONTROL);
    if (text.length > max || new TextEncoder().encode(text).length > max) throw Error('This batch has too many long filenames. Send fewer files at once.');
    rawSend(dc,text);
  }
  function notify(dc, message) { try { control(dc,message); } catch {} }
  function transportLost(job) {
    return job.dc.readyState !== 'open' || S.dc !== job.dc ||
      ['disconnected','failed','closed'].includes(S.pc?.connectionState) ||
      job.controller.signal.reason === 'beamsync-interrupt';
  }
  function storageFailure(error) {
    return ['QuotaExceededError','NotReadableError','UnknownError','NotFoundError'].includes(error?.name);
  }
  function failureText(error, direction) {
    if (error?.name === 'QuotaExceededError') return 'The browser ran out of space while saving this file. Free space on the receiving device, then offer the file again.';
    if (storageFailure(error)) return direction === 'receive'
      ? 'The browser could not read or save a file block ('+error.name+'). Reconnect and offer the file again.'
      : 'The browser could not read the source file ('+error.name+'). Choose the original file and retry.';
    return error?.message || 'The browser could not finish the transfer ('+(error?.name || 'unknown error')+').';
  }
  function assertActive(job) {
    if (active !== job || job.controller.signal.aborted || S.dc !== job.dc || job.dc.readyState !== 'open') throw Error('Transfer interrupted.');
  }
  function resetTimer(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => stop(job,'No response from the other device. Reconnect and send the file again.','error',true),STALL);
  }
  function start(id, direction, data) {
    const dc = S.dc;
    if (!dc || dc.readyState !== 'open') throw Error('Connect the devices first.');
    if (active) throw Error('Another file transfer is in progress.');
    const job = {id,direction,dc,controller:new AbortController(),phase:'proposal',next:0,doneBytes:0,
      queue:Promise.resolve(),queued:0,queuedCount:0,writer:null,waiter:null,file:null,...data};
    job.onClose = () => stop(job,'Connection lost. Reconnect and offer the same file again.','error',true,false);
    dc.addEventListener('close',job.onClose);
    active = job;
    if ($('offerFiles')) $('offerFiles').disabled = true;
    visible('cancelTransfer',true);
    resetTimer(job);
    return job;
  }
  function release(job,keep = false) {
    if (active !== job) return false;
    active = null;
    clearTimeout(job.timer);
    job.dc.removeEventListener('close',job.onClose);
    job.controller.abort(keep ? 'beamsync-interrupt' : 'beamsync-discard');
    if ($('offerFiles')) $('offerFiles').disabled = false;
    visible('cancelTransfer',false);
    visible('incomingOffer',false);
    emit('offer-closed',{id:job.id});
    return true;
  }
  function stop(job, message, level, keep, inform = true) {
    if (!job || !release(job,keep)) return;
    job.keep = keep;
    if (inform) notify(job.dc, {t:'transfer-abort',id:job.id,keep:!!keep,failed:level==='error',
      reason:job.storageFailure ? 'receiver-storage' : undefined});
    job.waiter?.reject(Error(message));
    const writer = job.writer;
    // Allow an in-flight transaction to settle before releasing its lock or deleting it.
    job.queue.finally(async () => {
      if (writer) await (keep ? writer.interrupt() : writer.discard());
    }).catch(() => {});
    state(job.direction,level,message);
  }
  function complete(job) {
    if (release(job)) state(job.direction,'success','All files were received and verified.');
  }
  function renderOffer(job) {
    const list = $('incomingList');
    if (list) {
      list.replaceChildren();
      for (const file of job.meta) {
        const line = document.createElement('div');
        line.className = 'incoming-file';
        line.textContent = file.name + ' · ' + fmtBytes(file.size);
        list.append(line);
      }
    }
    visible('incomingOffer',true);
    if ($('acceptFiles')) $('acceptFiles').disabled = false;
    label('spaceHint',job.meta.length+' file(s), '+fmtBytes(job.total)+' total.');
    emit('offer',{id:job.id,files:job.meta.map(f=>({...f})),total:job.total,resumeSupported:job.modern});
    navigator.storage?.estimate?.().then(estimate=>{
      if (active !== job || job.phase !== 'proposal' || !Number.isFinite(estimate?.quota) || !Number.isFinite(estimate.usage)) return;
      const free = Math.max(0,estimate.quota-estimate.usage);
      label('spaceHint',job.meta.length+' file(s), '+fmtBytes(job.total)+' total. Estimated space available: '+fmtBytes(free)+'.');
      emit('space',{id:job.id,free});
    }).catch(()=>{});
  }
  function receiveOffer(dc,m) {
    if (!ID.test(typeof m.id === 'string' ? m.id : '')) return;
    if (active) { notify(dc,{t:'proposal-response',id:m.id,accept:false,reason:'busy'}); return; }
    try {
      const offer = plan(m.files,m.total,true);
      const retained = downloads.reduce((n,f) => n+f.size,0);
      if (retained + offer.total > MAX_TOTAL || downloads.length + offer.meta.length > 100) throw Error('Save your received files, then clear the download list to make room.');
      const job = start(m.id,'receive',{...offer,modern:m.v === 14});
      state('receive','pending','Review this file offer.');
      renderOffer(job);
    } catch (err) {
      notify(dc,{t:'proposal-response',id:m.id,accept:false,reason:'invalid'});
      state('receive','error',err.message);
    }
  }
  function acceptFiles(options = {}) {
    const job = active;
    if (!job || job.direction !== 'receive' || job.phase !== 'proposal') return;
    try {
      assertActive(job);
      job.recover = job.modern && (options.recover ?? !!$('retainCheckpoints')?.checked);
      job.peer = typeof options.peer === 'string' ? options.peer : undefined;
      job.phase = 'accepted';
      control(job.dc,{t:'proposal-response',id:job.id,accept:true,v:14});
      visible('incomingOffer',false);
      emit('offer-closed',{id:job.id});
      resetTimer(job);
      state('receive','active','Accepted. Waiting for the file.');
    } catch (e) { stop(job,e.message,'error',true); }
  }
  function declineFiles() {
    const job = active;
    if (job?.direction !== 'receive' || job.phase !== 'proposal') return;
    notify(job.dc,{t:'proposal-response',id:job.id,accept:false,reason:'declined'});
    stop(job,'File offer declined.','cancelled',false,false);
  }
  function sendFiles(input) {
    let job;
    try {
      const files = Array.from(input || []), info = plan(files,undefined,false);
      job = start(randId(12),'send',{files,...info});
      control(job.dc,{t:'proposal',v:14,id:job.id,files:job.meta,total:job.total});
      state('send','pending','Waiting for the other device to accept.');
      return job.id;
    } catch (err) {
      if (job) stop(job,err.message,'error',false);
      else state('send','error',err.message);
      return null;
    }
  }

  // Exactly one outstanding response per sender. Install it before issuing
  // the request so that fast local delivery cannot outrun registration.
  function request(job,message,reply,match) {
    assertActive(job);
    return new Promise((resolve,reject) => {
      job.waiter = {reply,match,resolve,reject};
      try { control(job.dc,message); resetTimer(job); }
      catch(e) { job.waiter=null; reject(e); }
    });
  }
  async function indexFile(job,file) {
    const hash = new BeamSHA256(), prefixes = [hash.hex()];
    for (let offset=0; offset<file.size; offset+=BLOCK) {
      assertActive(job);
      const part = new Uint8Array(await file.slice(offset,offset+BLOCK).arrayBuffer());
      assertActive(job);
      hash.update(part);
      prefixes.push(hash.hex());
      resetTimer(job);
    }
    return {digest:hash.hex(),prefixes};
  }
  function waitDrain(job,flow) {
    const dc = job.dc;
    assertActive(job);
    if (dc.bufferedAmount <= flow.high) return Promise.resolve();
    const low = Math.floor(flow.high / 3), began = performance.now();
    dc.bufferedAmountLowThreshold = low;
    return new Promise((resolve,reject) => {
      const clean = () => {
        clearInterval(poll);
        dc.removeEventListener('bufferedamountlow',check);
        job.controller.signal.removeEventListener('abort',check);
      };
      function check() {
        try { assertActive(job); }
        catch(e) { clean(); reject(e); return; }
        const elapsed = performance.now()-began;
        if (dc.bufferedAmount <= low) {
          clean();
          flow.high = elapsed < 120 ? Math.min(2*BLOCK,flow.high+128*1024)
            : elapsed > 400 ? Math.max(64*1024,Math.floor(flow.high/2)) : flow.high;
          resolve();
        } else if (elapsed > 30000) {
          clean();
          reject(Error('The connection stopped draining. Reconnect to retry.'));
        }
      }
      const poll = setInterval(check,100);
      dc.addEventListener('bufferedamountlow',check);
      job.controller.signal.addEventListener('abort',check);
      check();
    });
  }
  async function sendJob(job) {
    const flow = {high:512*1024};
    const frameSize = Math.min(FRAME, S.pc?.sctp?.maxMessageSize || FRAME);
    for (let i=0;i<job.files.length;i++) {
      assertActive(job);
      const blob = job.files[i], file = job.meta[i], fileId = job.id+':'+i;
      state('send','active','Checking '+file.name+' before sending.');
      const {digest,prefixes} = await indexFile(job,blob);
      assertActive(job);
      const base = {transferId:job.id,fileId};
      const startMessage = {t:'file-start',...base,...file,sha256:digest,index:i,count:job.meta.length};
      let offset = 0;
      const identity = m => m.transferId === job.id && m.fileId === fileId;
      if (job.modern) {
        const ready = await request(job,startMessage,'file-ready',identity);
        offset = ready.offset;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size ||
          (offset !== file.size && offset % BLOCK !== 0) || ready.prefix !== prefixes[Math.ceil(offset/BLOCK)]) {
          throw Error('The saved checkpoint differs from the source. Offer the file again to restart.');
        }
        if (offset) {
          if (typeof ready.nonce !== 'string' || !NONCE.test(ready.nonce)) throw Error('Invalid checkpoint challenge.');
          // Demonstrate possession of the saved bytes, including when the
          // checkpoint already covers the whole file. A known digest is insufficient.
          const proof = new BeamSHA256().update(new TextEncoder().encode(ready.nonce));
          for (let pos=0;pos<offset;pos+=BLOCK) {
            assertActive(job);
            proof.update(new Uint8Array(await blob.slice(pos,Math.min(offset,pos+BLOCK)).arrayBuffer()));
            resetTimer(job);
          }
          await request(job,{t:'file-proof',...base,proof:proof.hex()},'file-proof-ok',identity);
        }
      } else control(job.dc,startMessage);
      progress(job,file,offset);
      while (offset<file.size) {
        const part = new Uint8Array(await blob.slice(offset,offset+BLOCK).arrayBuffer());
        assertActive(job);
        const checksum = job.modern ? await blockHash(part) : null;
        for (let pos=0;pos<part.length;pos+=frameSize) {
          await waitDrain(job,flow);
          assertActive(job);
          rawSend(job.dc,part.subarray(pos,pos+frameSize));
        }
        offset += part.length;
        if (job.modern) {
          const receipt = await request(job,{t:'file-block',...base,offset,sha256:checksum},'block-ok',identity);
          if (receipt.offset !== offset || receipt.sha256 !== checksum) throw Error('The checkpoint receipt did not match.');
        }
        resetTimer(job);
        progress(job,file,offset);
      }
      state('send','active','Waiting for verified receipt of '+file.name+'.');
      const receipt = await request(job,{t:'file-end',...base},'file-confirm',identity);
      if (receipt.ok !== true || receipt.sha256 !== digest) throw Error('The receiver could not verify '+file.name+'.');
      job.doneBytes += file.size;
    }
    if (job.modern) await request(job,{t:'transfer-complete',id:job.id},'transfer-confirm',m=>m.id===job.id);
    else control(job.dc,{t:'transfer-complete',id:job.id});
    complete(job);
  }
  async function blockHash(part) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',part));
    return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
  }
  function receiveResponse(m) {
    const job = active;
    if (!job || job.direction !== 'send' || job.phase !== 'proposal' || m.id !== job.id) return;
    if (m.accept !== true) {
      stop(job,m.reason==='busy'?'The other device is busy.':'The other device declined this offer.','cancelled',false,false);
      return;
    }
    job.phase = 'accepted';
    job.modern = m.v === 14;
    sendJob(job).catch(e=>stop(job,failureText(e,'send'),'error',transportLost(job) || storageFailure(e)));
  }

  async function beginFile(job,m) {
    const file = job.meta[job.next], fileId = job.id+':'+job.next;
    if (job.phase !== 'accepted' || job.file || !file || m.transferId !== job.id || m.fileId !== fileId ||
        m.size !== file.size || m.index !== job.next || m.count !== job.meta.length ||
        safeName(m.name) !== file.name || mimeType(m.mime) !== file.mime ||
        typeof m.sha256 !== 'string' || !DIGEST.test(m.sha256)) throw Error('Incoming file does not match the accepted offer.');
    const hash = new BeamSHA256(), nonce = randId(16);
    const prefixProof = new BeamSHA256().update(new TextEncoder().encode(nonce));
    const writer = await window.BeamSyncRecovery.open({...file,sha256:m.sha256},{
      resumable:!!job.recover, peer:job.peer, signal:job.controller.signal, onPrefix:bytes=>{hash.update(bytes); prefixProof.update(bytes); resetTimer(job);}
    });
    if (active !== job) {
      await (job.keep ? writer.interrupt() : writer.discard());
      return;
    }
    job.writer = writer;
    job.file = {metadata:file,fileId,hash,digest:m.sha256,received:writer.offset,parts:[],pending:0,proof:writer.offset ? prefixProof.hex() : null};
    if (job.modern) control(job.dc,{t:'file-ready',transferId:job.id,fileId,offset:writer.offset,prefix:hash.hex(),nonce:writer.offset ? nonce : undefined});
    state('receive','active',writer.offset?'Resuming '+file.name+'.':'Receiving '+file.name+'.');
    progress(job,file,writer.offset);
    if (job.recover && !writer.resumable) {
      const message = 'Browser storage is unavailable. This file can finish, but an interruption will require sending it again.';
      state('receive','active',message);
      label('checkpointHint',message,'warn');
      emit('capability',{direction:'receive',resumable:false,message});
    }
  }
  async function saveBlock(job,expected) {
    const f = job.file;
    const data = new Blob(f.parts);
    const checksum = await job.writer.append(data,expected);
    assertActive(job);
    f.parts = [];
    f.pending = 0;
    progress(job,f.metadata,f.received);
    return checksum;
  }
  async function receiveBytes(job,data,length) {
    const f = job.file;
    if (!f || f.proof || !length || length > 65536 || f.received+length > f.metadata.size)
      throw Error('Incoming file exceeds its accepted size or frame limit.');
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    assertActive(job);
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength !== length) throw Error('Invalid file frame.');
    f.hash.update(bytes);
    // Legacy frames may straddle block boundaries. Modern frames cannot begin
    // another block until the preceding authenticated block was acknowledged.
    for (let pos=0;pos<length;) {
      const room = BLOCK - f.pending;
      if (room <= 0) throw Error('Checkpoint marker missing.');
      const count = Math.min(length-pos,room);
      f.parts.push(bytes.subarray(pos,pos+count));
      f.received += count;
      f.pending += count;
      pos += count;
      if (!job.modern && (f.pending===BLOCK || f.received===f.metadata.size)) await saveBlock(job);
    }
  }
  function checkCurrent(job,m) {
    const f = job.file;
    if (!f || m.transferId !== job.id || m.fileId !== f.fileId) throw Error('Message does not match the active file.');
    return f;
  }
  async function verifyBlock(job,m) {
    const f = checkCurrent(job,m);
    if (!job.modern || !f.pending || m.offset !== f.received || typeof m.sha256 !== 'string' ||
        !DIGEST.test(m.sha256) || (f.pending !== BLOCK && f.received !== f.metadata.size)) throw Error('Invalid checkpoint.');
    const sha256 = await saveBlock(job,m.sha256);
    control(job.dc,{t:'block-ok',transferId:job.id,fileId:f.fileId,offset:f.received,sha256});
  }
  function displayFile(file) {
    downloads.push(file);
    const box = $('received');
    if (box) {
      const link = document.createElement('a');
      link.href = file.url;
      link.download = file.name;
      link.textContent = 'Save '+file.name+' ('+fmtBytes(file.size)+')';
      box.append(link);
    }
    emit('received',file);
  }
  async function finishFile(job,m) {
    const f = checkCurrent(job,m);
    if (f.proof || f.pending || f.received !== f.metadata.size || f.hash.hex() !== f.digest) throw Error('File integrity check failed.');
    const blob = await job.writer.finish();
    assertActive(job);
    if (blob.size !== f.metadata.size) throw Error('Saved file size differs from the accepted file.');
    displayFile({name:f.metadata.name,size:blob.size,sha256:f.digest,url:URL.createObjectURL(blob)});
    job.writer = null;
    job.file = null;
    job.next++;
    job.doneBytes += blob.size;
    control(job.dc,{t:'file-confirm',transferId:job.id,fileId:f.fileId,ok:true,sha256:f.digest});
  }
  function enqueue(job,operation,bytes=0) {
    if (job.phase !== 'accepted') return;
    job.queued += bytes;
    job.queuedCount++;
    if (job.queued > 16*BLOCK || job.queuedCount > 2048) {
      stop(job,'Receiver could not keep up. Reconnect and retry.','error',true);
      return;
    }
    job.queue = job.queue.then(async () => {
      if (active !== job) return;
      assertActive(job);
      await operation();
      if (active === job) resetTimer(job);
    }).catch(e => {
      // A closing channel changes readyState before the browser delivers
      // its close event. Treat a queued operation in that gap as an
      // interruption, or its error handler will delete the last good block.
      job.storageFailure = storageFailure(e);
      const keep = transportLost(job) || job.storageFailure;
      if (!keep && active === job && job.file) notify(job.dc,{t:'file-confirm',transferId:job.id,fileId:job.file.fileId,ok:false,sha256:''});
      stop(job,failureText(e,'receive'),'error',keep);
    }).finally(()=>{job.queued-=bytes;job.queuedCount--;});
  }
  function appendChat(who,text) {
    const chat = $('chat');
    if (chat) {
      while (chat.childElementCount >= 100) chat.firstElementChild.remove();
      const line = document.createElement('div');
      line.className='msg';
      line.textContent=who+': '+text;
      chat.append(line);
      chat.scrollTop=chat.scrollHeight;
    }
    window.dispatchEvent(new CustomEvent('beamsync:chat',{detail:{who,text}}));
  }
  function sendMessage() {
    const input = $('message'), text = input?.value.trim().slice(0,4000);
    if (!text || S.dc?.readyState !== 'open') return;
    control(S.dc,{t:'chat',text});
    appendChat('Me',text);
    input.value='';
  }
  function onMessage(event) {
    const dc = S.dc;
    if (!dc || dc.readyState !== 'open' || (event.target && event.target !== dc)) return;
    const data = event.data, job = active;
    if (typeof data !== 'string') {
      if (job?.direction !== 'receive' || job.dc !== dc) return;
      const length = data instanceof Blob ? data.size : data.byteLength;
      if (!Number.isSafeInteger(length) || length <= 0 || length > 65536) {
        stop(job,'Invalid file frame.','error',false);
        return;
      }
      enqueue(job,()=>receiveBytes(job,data,length),length);
      return;
    }
    if (data.length > MAX_CONTROL) {
      if (job) stop(job,'Oversized control message.','error',false);
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (m.t === 'chat') {
      if (typeof m.text === 'string' && m.text.length <= 4000) appendChat('Peer',m.text);
      return;
    }
    if (m.t === 'proposal') { receiveOffer(dc,m); return; }
    if (!job || job.dc !== dc) return;
    if (m.t === 'transfer-abort' && m.id === job.id) {
      const text = m.reason === 'receiver-storage' ? 'The receiving browser could not save the file. Check storage on the other device, then retry.'
        : m.failed === true ? 'The other device could not finish the transfer. Check its transfer status.' : 'The other device stopped this transfer.';
      stop(job,text,
        m.failed === true ? 'error' : 'cancelled',m.keep === true,false);
      return;
    }
    if (m.t === 'proposal-response') { receiveResponse(m); return; }
    if (job.direction === 'send') {
      const waiter = job.waiter;
      if (m.t === 'file-confirm' && m.transferId === job.id && m.ok === false) {
        stop(job,'The receiver rejected the file.','error',false);
      } else if (waiter && m.t === waiter.reply && waiter.match(m)) {
        job.waiter = null;
        waiter.resolve(m);
      }
      return;
    }
    if (m.t === 'file-start') enqueue(job,()=>beginFile(job,m));
    else if (m.t === 'file-proof') enqueue(job,()=>{
      const f = checkCurrent(job,m);
      if (!f.proof || m.proof !== f.proof) throw Error('The selected source does not match the saved checkpoint.');
      f.proof = null;
      control(job.dc,{t:'file-proof-ok',transferId:job.id,fileId:f.fileId});
    });
    else if (m.t === 'file-block') enqueue(job,()=>verifyBlock(job,m));
    else if (m.t === 'file-end') enqueue(job,()=>finishFile(job,m));
    else if (m.t === 'transfer-complete') enqueue(job,()=>{
      if (m.id !== job.id || job.next !== job.meta.length || job.file) throw Error('Transfer ended before all accepted files were verified.');
      if (job.modern) control(job.dc,{t:'transfer-confirm',id:job.id});
      complete(job);
    });
  }
  function resetTransfers() {
    if (active) stop(active,'Transfer interrupted. Reconnect and offer the same file again.','cancelled',true);
    for (const direction of ['send','receive']) {
      const bar = $(direction+'Bar');
      if (bar) bar.style.width='0%';
    }
  }
  function cancelTransfer() {
    if (active?.phase === 'proposal' && active.direction === 'receive') declineFiles();
    else if (active) stop(active,'Transfer cancelled.','cancelled',false);
  }
  function clearReceived() {
    for (const file of downloads) URL.revokeObjectURL(file.url);
    downloads.length=0;
    $('received')?.replaceChildren();
    emit('cleared');
  }
  hooks.onMessage = onMessage;
  window.addEventListener('pagehide',event=>{
    if (active) stop(active,'Transfer interrupted.','cancelled',true);
    if (!event.persisted) clearReceived();
  });
  window.BeamSyncTransfer = {sendMessage,offerFiles:()=>sendFiles($('files')?.files),sendFiles,acceptFiles,
    declineFiles,resetTransfers,cancelTransfer,clearReceived,onMessage,MAX_FILE,MAX_TOTAL};
})();
