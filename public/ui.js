const byId = id => document.getElementById(id);
const hide = (id, hidden) => { byId(id).hidden = hidden; };
const write = (id, text) => { byId(id).textContent = text ?? ''; };
const listen = (id, event, fn) => byId(id).addEventListener(event, fn);
const el = (tag, text = '', className = '') => {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
};

function readableBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}).format(bytes / 1024 ** unit)
    + ' ' + ['B', 'KiB', 'MiB', 'GiB'][unit];
}

function button(name, fn) {
  const btn = el('button', name, 'btn quiet small');
  btn.type = 'button';
  btn.addEventListener('click', fn);
  return btn;
}

function listRow(name, detail) {
  const item = el('li', '', 'row');
  const words = el('div', '', 'row-text');
  words.append(el('strong', name));
  if (detail) words.append(el('span', detail, 'hint'));
  item.append(words);
  return item;
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {}
  return null;
}

function openDialog(id) {
  const dialog = byId(id);
  if (!dialog.open) dialog.showModal();
}
function closeDialog(id) {
  if (byId(id).open) byId(id).close();
}

/* Camera access starts only after a tap. Closing the reader invalidates pending camera requests. */
function makeScanner(onResult, onPaste) {
  const video = byId('scan-video');
  const canvas = byId('scan-canvas');
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  let epoch = 0, stream = null, timer = 0;
  function stop() {
    epoch++;
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    hide('camera-stop', true);
    hide('camera-start', false);
  }
  function decode(source, width, height) {
    if (!ctx || !width || !height || typeof window.jsQR !== 'function') return '';
    const scale = Math.min(1, 850 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(data.data, data.width, data.height, {inversionAttempts:'dontInvert'})?.data || '';
  }
  function result(value) {
    const url = safeWebUrl(value);
    if (!url || url.origin !== location.origin || !url.hash || value.length > 8192) {
      write('scan-note', 'This QR is not an invitation from this BeamSync site.');
      return false;
    }
    stop();
    closeDialog('scan-dialog');
    onResult(value);
    return true;
  }
  async function camera() {
    stop();
    const current = epoch;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !ctx || !window.jsQR) throw Error();
      const next = await navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:{ideal:'environment'}}});
      if (current !== epoch) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next;
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      if (current !== epoch) return;
      hide('camera-stop', false);
      hide('camera-start', true);
      write('scan-note', 'Hold the pairing QR inside the camera view.');
      function tick() {
        if (current !== epoch) return;
        try {
          const value = decode(video, video.videoWidth, video.videoHeight);
          if (value && result(value)) return;
        } catch {}
        timer = setTimeout(tick, 160);
      }
      tick();
    } catch {
      if (current !== epoch) return;
      stop();
      write('scan-note', 'Camera unavailable. Choose a QR image or paste the invitation link.');
    }
  }
  async function readImage(file) {
    stop();
    const current = epoch;
    if (!file || file.size > 12 * 1024 * 1024) {
      write('scan-note', 'Choose a QR image under 12 MiB.');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      if (current !== epoch) return;
      const value = decode(image, image.naturalWidth, image.naturalHeight);
      if (value) result(value);
      else write('scan-note', 'No readable QR found. Try a closer image or paste the link.');
    } catch {
      if (current === epoch) write('scan-note', 'This image could not be read. Paste the invitation link instead.');
    } finally { URL.revokeObjectURL(objectUrl); }
  }
  listen('camera-start', 'click', camera);
  listen('camera-stop', 'click', stop);
  listen('image-open', 'click', () => byId('scan-image').click());
  listen('scan-image', 'change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) readImage(file);
  });
  listen('scan-close', 'click', () => closeDialog('scan-dialog'));
  listen('scan-dialog', 'close', stop);
  listen('paste-link-instead', 'click', () => { closeDialog('scan-dialog'); onPaste(); });
  window.addEventListener('pagehide', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return () => {
    write('scan-note', 'Point the camera at the QR on the sending device, or choose a saved image.');
    openDialog('scan-dialog');
  };
}

export function createUI(handleAction) {
  let selectedTab = 'send', files = [], connected = false, busy = false, quick = false;
  let pendingUrl = '', expiryTimer = 0, safetyCode = '', transferBusy = false;
  const receivedDisposers = new Set();
  const tabs = ['send', 'receive', 'devices'];

  function status(message, kind = 'info') {
    write('notice', message);
    byId('notice').dataset.kind = kind;
    hide('notice', !message);
  }
  function act(action, payload = {}) {
    try {
      return Promise.resolve(handleAction(action, payload)).catch(error => { status(error?.message || 'This action could not finish.', 'error'); });
    } catch(error) {
      status(error?.message || 'This action could not finish.', 'error');
      return Promise.resolve();
    }
  }
  function renderPairing() {
    const receiving = selectedTab === 'receive';
    hide('quick-first', connected || !quick);
    hide('legacy-first', connected || quick);
    hide('session-tools', !connected && !busy);
    hide('offline-options', connected || busy);
    hide('quick-help', !quick || connected || busy);
    hide('pair', receiving);
    hide('scan', !receiving);
    byId('offline-primary').disabled = busy;
    byId('pair').disabled = busy;
    byId('scan').disabled = busy;
    byId('network-mode').disabled = connected || busy;
    write('offline-primary', receiving ? 'Scan offline QR' : 'Create offline QR');
    write('disconnect', connected ? 'Disconnect' : 'Cancel pairing');
    const helper = quick
      ? (receiving ? 'Scan the pairing QR shown on the sending device.' : 'Show a pairing QR to the device you want to send to.')
      : (receiving ? 'Scan the sender’s QR first. Then show your reply QR for the sender to scan.' : 'Show your QR to the receiver. Then scan the reply on the receiver’s screen.');
    write('pair-guide', connected ? 'You can share in either direction while both devices are connected.' : helper);
  }
  function renderFiles() {
    const queue = byId('queue');
    queue.replaceChildren();
    for (const [i,file] of files.slice(0,12).entries()) {
      const row = listRow(file.name,readableBytes(file.size));
      const remove = button('Remove', () => { files.splice(i,1); renderFiles(); });
      remove.setAttribute('aria-label','Remove ' + file.name);
      row.append(remove);
      queue.append(row);
    }
    if (files.length > 12) queue.append(el('li', 'And ' + (files.length - 12) + ' more'));
    write('selection-count', String(files.length) + ' selected');
    hide('selection-count', !files.length);
    hide('queue-controls', !files.length);
    write('pick-title', files.length ? 'Add more files' : 'Choose files to send');
    write('queue-hint', connected ? 'The other device can review the offer before accepting.' : 'Connect the other device to offer these files.');
    byId('send-files').disabled = !connected || busy || transferBusy || !files.length;
  }
  function renderText() {
    byId('send-text').disabled = !connected || busy || !byId('share-text').value.trim();
    write('text-hint',connected ? 'The other device will receive the text when you tap Send.' : 'Connect a device to send.');
  }
  function addFiles(list) {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    if (files.length + picked.length > 100) { status('Choose up to 100 files at a time.', 'error'); return; }
    if (picked.some(file => file.size > 250 * 1024 ** 2)) { status('Each file must be 250 MiB or smaller.', 'error'); return; }
    if ([...files,...picked].reduce((sum,file) => sum + file.size,0) > 500 * 1024 ** 2) {
      status('Choose a batch of 500 MiB or less.', 'error'); return;
    }
    files.push(...picked);
    renderFiles();
  }
  function tab(name, focus = false) {
    if (!tabs.includes(name)) return;
    selectedTab = name;
    for (const key of tabs) {
      const selected = key === name, control = byId('tab-' + key);
      control.setAttribute('aria-selected',String(selected));
      control.tabIndex = selected ? 0 : -1;
      hide('panel-' + key,!selected);
      if (selected && focus) control.focus();
    }
    renderPairing();
  }
  tabs.forEach((name,index) => {
    listen('tab-' + name,'click',() => tab(name));
    listen('tab-' + name,'keydown',event => {
      const dest = {ArrowRight:(index+1)%3,ArrowLeft:(index+2)%3,Home:0,End:2}[event.key];
      if (dest === undefined) return;
      event.preventDefault();
      tab(tabs[dest],true);
    });
  });

  async function copy(text, fallback) {
    try { await navigator.clipboard.writeText(text); status('Copied to clipboard.'); }
    catch {
      fallback?.();
      status('Clipboard access is unavailable. Select the text and use Copy.');
    }
  }
  function selectContents(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function dismissInvite() {
    clearTimeout(expiryTimer);
    expiryTimer = 0;
    byId('pair-link').value = '';
    byId('invite-qr').replaceChildren();
    hide('invite-box',true);
  }
  function pendingInvite(url) {
    if (url && (!quick || connected || busy)) return;
    pendingUrl = String(url || '');
    hide('startup-invite',!pendingUrl);
    if (pendingUrl) {
      tab('receive');
      const join = byId('accept-invite');
      join.focus({preventScroll:true});
      join.scrollIntoView({block:'center'});
    }
  }
  function recognition({code='',label='',canIdentify=true,canTrust=false,trusted=false} = {}) {
    if (code !== safetyCode || !canTrust) byId('matching').checked = false;
    safetyCode = code;
    write('identity-label',label || 'Compare the code on both devices before saving.');
    write('recognition-code',code);
    hide('recognition-code',!code);
    hide('identify',!canIdentify || trusted);
    const ask = Boolean(code && canTrust && !trusted);
    for (const id of ['matching-label','trust','device-name-label','device-name']) hide(id,!ask);
    byId('trust').disabled = !ask || !byId('matching').checked;
    if (ask) byId('identity-panel').open = true;
  }
  const openScanner = makeScanner(pendingInvite, () => {
    byId('methods').open = true;
    byId('join-code').focus();
  });
  listen('scan','click',openScanner);
  listen('pair','click',() => act('pair'));
  listen('offline-primary','click',() => act('offlinePair',{role:selectedTab === 'receive' ? 'receive' : 'send'}));
  for (const role of ['send','receive']) listen('offline-'+role,'click',() => act('offlinePair',{role}));
  listen('offline-close','click',() => act('closeOffline'));
  listen('offlineDialog','cancel',event => { event.preventDefault(); act('closeOffline'); });
  listen('join','click',() => {
    const code = byId('join-code').value.trim();
    if (!code) { byId('join-code').focus(); return; }
    byId('join-code').value = '';
    act('join',{code});
  });
  listen('accept-invite','click',() => {
    if (!pendingUrl) return;
    const code = pendingUrl;
    pendingInvite('');
    act('join',{code});
  });
  listen('copy-invite','click',() => copy(byId('pair-link').value,() => {byId('pair-link').focus(); byId('pair-link').select();}));
  listen('choose-files','click',() => byId('files').click());
  listen('files','change',event => {addFiles(event.target.files); event.target.value='';});
  for (const event of ['dragover','dragleave','drop']) listen('drop-zone',event,e => {
    e.preventDefault();
    byId('drop-zone').classList.toggle('over',event === 'dragover');
    if (event === 'drop') addFiles(e.dataTransfer.files);
  });
  listen('send-files','click',() => {if (connected && !busy && !transferBusy && files.length) act('sendFiles',{files:[...files]});});
  listen('share-text','input',renderText);
  listen('send-text','click',() => act('sendText',{text:byId('share-text').value}));
  listen('paste-text','click',() => {byId('share-text').focus(); act('pasteText');});
  listen('accept','click',() => act('accept',{recover:!byId('retainCheckpoints').disabled && byId('retainCheckpoints').checked}));
  listen('decline','click',() => act('decline'));
  listen('cancel','click',() => act('cancel'));
  listen('disconnect','click',() => act('disconnect'));
  listen('identify','click',() => act('identify'));
  listen('matching','change',() => {byId('trust').disabled = !byId('matching').checked;});
  listen('trust','click',() => {
    if (byId('matching').checked && safetyCode) act('trust',{name:byId('device-name').value.trim(),code:safetyCode});
  });
  listen('clear-received','click',() => { clearReceived(); act('clearReceived'); });
  function clearReceived() {
    byId('inbox').replaceChildren();
    for (const dispose of receivedDisposers) { try {dispose();} catch {} }
    receivedDisposers.clear();
    hide('receive-empty',false);
    hide('inbox-limit',true);
    hide('clear-received',true);
  }
  function inboxRow(row) {
    byId('inbox').prepend(row);
    hide('receive-empty',true);
    hide('clear-received',false);
  }
  function connection(state = {}) {
    connected = Boolean(state.connected);
    busy = Boolean(state.busy);
    write('connection-label',state.label || (connected ? 'Connected' : 'No device connected'));
    write('pair-title',connected ? (state.peer || 'Device connected') : 'Connect a device');
    document.body.classList.toggle('connected',connected);
    hide('identity-panel',!connected);
    if (connected || busy) pendingInvite('');
    if (connected) dismissInvite();
    else {recognition(); byId('identity-panel').open = false; byId('device-name').value = '';}
    renderPairing(); renderFiles(); renderText();
  }
  function invite({url,expiresAt} = {}) {
    dismissInvite();
    if (!url) return;
    hide('invite-box',false);
    byId('pair-link').value = url;
    try {
      const qr = window.qrcode(0,'M');
      qr.addData(url,'Byte');
      qr.make();
      const image = el('img');
      image.alt = 'Private connection invitation QR';
      image.src = qr.createDataURL(5,20);
      byId('invite-qr').append(image);
    } catch { byId('invite-qr').append(el('p','QR unavailable. Use the invitation link below.','hint')); }
    const deadline = new Date(expiresAt).getTime();
    if (Number.isFinite(deadline)) {
      write('invite-expiry','Expires at ' + new Date(deadline).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) + '.');
      expiryTimer = setTimeout(() => {dismissInvite(); status('This invitation expired. Create a new QR to try again.');},Math.max(0,deadline-Date.now()));
    } else write('invite-expiry','This link is private. Only show it to your other device.');
  }
  function incoming(offer) {
    hide('incoming',!offer);
    const list = byId('incoming-files');
    list.replaceChildren();
    byId('retainCheckpoints').checked = false;
    if (!offer) return;
    tab('receive');
    write('incoming-peer',offer.peer ? 'From '+offer.peer : 'Review the files before accepting.');
    byId('retainCheckpoints').disabled = !offer.canRecover;
    hide('retain-label',!offer.canRecover);
    for (const file of offer.files || []) list.append(listRow(file.name,readableBytes(file.size)));
  }
  function progress({name='',done=0,total=0,label='',cancellable=true,rate,eta} = {}) {
    hide('progress-box',false);
    write('progress-title',label || 'Transferring');
    write('progress-name',name);
    const bar = byId('progress-bar');
    if (total>0) { bar.max=total; bar.value = Math.min(total,Math.max(0,done)); } else bar.removeAttribute('value');
    const details = [];
    if (total > 0) details.push(readableBytes(done) + ' / ' + readableBytes(total));
    if (Number.isFinite(rate) && rate > 0) details.push(readableBytes(rate) + '/s');
    if (Number.isFinite(eta) && eta >= 1) {
      const time = eta < 60 ? Math.ceil(eta) + ' sec' : Math.ceil(eta / 60) + ' min';
      details.push('about ' + time + ' left');
    }
    write('progress-label',details.join(' · '));
    hide('cancel',!cancellable);
  }
  function received({name,url,dispose} = {}) {
    let target;
    try {target = new URL(url);} catch {return;}
    if (target.protocol !== 'blob:' || target.origin !== location.origin) return;
    const row = listRow(name || 'Received file','Verified file');
    const link = el('a','Save file','btn quiet small');
    link.href = target.href;
    link.download = name || 'received-file';
    row.append(link); inboxRow(row);
    if (typeof dispose === 'function') receivedDisposers.add(dispose);
  }
  function shared({text,kind,url} = {}) {
    const row = el('li'), value = String(text || '');
    const content = el('p',value,'shared-text');
    row.append(content);
    const actions = el('div','','buttons');
    actions.append(button('Copy',() => copy(value,() => selectContents(content))));
    const web = kind === 'url' && safeWebUrl(url || value);
    if (web) {
      const link = el('a','Open link','btn quiet small');
      link.href = web.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    row.dataset.sharedMessage = '';
    row.append(actions);
    inboxRow(row);
    const messages = byId('inbox').querySelectorAll('[data-shared-message]');
    if (messages.length > 100) {
      messages[messages.length-1].remove();
      hide('inbox-limit',false);
    }
  }
  function devices(items = []) {
    const list = byId('devices');
    list.replaceChildren();
    write('device-hint',items.length ? 'Reconnect when both devices have BeamSync open.' : 'After connecting, compare the code on both screens to remember a device.');
    for (const device of items) {
      const row = listRow(device.name || 'Device',device.trusted ? 'Trusted device' : 'Previously connected');
      row.append(button('Reconnect',() => act('reconnect',{id:device.id})));
      row.append(button('Forget',() => {if (confirm('Forget this device in this browser?')) act('forget',{id:device.id});}));
      list.append(row);
    }
  }
  function partials(items = []) {
    const list = byId('partials');
    list.replaceChildren();
    write('partial-hint',items.length ? 'Reconnect and offer the same original file to resume from verified data.' : 'No saved transfers found in this browser.');
    for (const item of items) {
      const row = listRow(item.name,readableBytes(item.bytes)+' saved');
      if (!item.active) row.append(button('Discard',() => {if (confirm('Discard these saved file parts?')) act('discard',{id:item.id});}));
      list.append(row);
    }
  }
  function pairingAvailable(enabled,reason='') {
    quick = Boolean(enabled);
    write('feature-reason',reason);
    hide('feature-reason',!reason);
    renderPairing();
  }
  window.addEventListener('pagehide',event => {if (!event.persisted) clearReceived();});
  renderPairing(); renderFiles(); renderText();
  return {tab,status,connection,invite,dismissInvite,pendingInvite,incoming,progress,received,shared,devices,partials,
    diagnostics:message => write('diagnostic-log',message), offline:message => write('offline-status',message),
    setText:text => {byId('share-text').value = text ?? ''; renderText();}, clearReceived,
    transferBusy:value => {transferBusy=Boolean(value); renderFiles();},
    pairingAvailable, resetProgress:() => hide('progress-box',true), recognition,
    openOffline:() => openDialog('offlineDialog'), closeOffline:() => closeDialog('offlineDialog'),
    clearFiles:() => {files=[];renderFiles();}
  };
}
