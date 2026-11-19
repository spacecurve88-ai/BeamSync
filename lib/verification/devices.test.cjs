const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = [path.join(__dirname, '../../public/js')]
  .find(p => p && fs.existsSync(path.join(p,'devices.js')));
require(path.join(base, 'devices.js'));
require(path.join(base, 'share.js'));
const { createSession, openStore } = globalThis.BeamSyncDevices;
const { makeFrame, parseFrame, safeURL, readClipboard, copyText } = globalThis.BeamSyncShare;

async function store() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicHex = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
  const entries = new Map();
  return {
    identity: async () => ({ publicHex, privateKey: pair.privateKey }),
    touch: async id => entries.get(id),
    save: async (id,label) => { const r = { id, label }; entries.set(id,r); return r; },
    forget: async id => entries.delete(id),
    entries
  };
}

function desc(role, fp) {
  return { type: role, sdp: ['v=0','m=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=fingerprint:sha-256 ' + Array(32).fill(fp).join(':'),'a=sctp-port:5000',''].join('\r\n') };
}
async function pair(options = {}) {
  const aStore = options.aStore || await store();
  const bStore = options.bStore || await store();
  const aOut = [], bOut = [];
  const a = createSession({ pc: { localDescription: desc('offer','aa'), remoteDescription: desc('answer','bb') },
    store: aStore, send: f => aOut.push(f), expectedId: options.expectedId });
  const b = createSession({ pc: { localDescription: desc('answer', options.otherDtls || 'bb'), remoteDescription: desc('offer','aa') },
    store: bStore, send: f => bOut.push(f) });
  return { a, b, aOut, bOut, aStore, bStore };
}

async function exchange(p) {
  await Promise.all([p.a.start(), p.b.start()]);
  await p.b.receive(p.aOut[0]); await p.a.receive(p.bOut[0]);
  if (p.aOut[1]) await p.b.receive(p.aOut[1]);
  if (p.bOut[1]) await p.a.receive(p.bOut[1]);
}

test('first pairing requires local opt-in and physical comparison', async () => {
  const p = await pair();
  await p.a.start();
  await p.b.receive(p.aOut[0]);
  assert.equal(p.b.state.status,'requested'); assert.equal(p.bOut.length,0);
  await p.b.start();
  await p.a.receive(p.bOut[0]); await p.a.receive(p.bOut[1]); await p.b.receive(p.aOut[1]);
  assert.equal(p.a.state.status,'new'); assert.equal(p.a.state.code,p.b.state.code);
  assert.match(p.a.state.code,/^(?:[0-9A-F]{4} ){3}[0-9A-F]{4}$/);
  assert.equal(p.aStore.entries.size,0); assert.equal(p.bStore.entries.size,0);
  await assert.rejects(p.a.remember('Galaxy','other'));
  await assert.rejects(p.a.remember('\u202ehidden',p.a.state.code));
  await p.a.remember('Galaxy',p.a.state.code);
  assert.equal(p.a.state.label,'Galaxy'); assert.equal(p.bStore.entries.size,0);
});
test('a saved device proves possession again; forgetting removes recognition', async () => {
  const p = await pair(); await exchange(p);
  await p.a.remember('Galaxy',p.a.state.code);
  const q = await pair({ aStore:p.aStore,bStore:p.bStore,expectedId:p.a.state.peerId });
  await exchange(q);
  assert.equal(q.a.state.status,'trusted'); assert.notEqual(q.a.state.code,p.a.state.code);
  await p.aStore.forget(q.a.state.peerId);
  const r = await pair({ aStore:p.aStore,bStore:p.bStore });
  await exchange(r); assert.equal(r.a.state.status,'new');
});
test('replayed valid proof from a prior session fails', async () => {
  const p = await pair(); await exchange(p);
  const q = await pair({ aStore:p.aStore,bStore:p.bStore });
  await q.a.start(); await q.a.receive(p.bOut[0]); await q.a.receive(p.bOut[1]);
  assert.equal(q.a.state.status,'failed');
});
test('proofs bound to different DTLS fingerprints and reflected proofs fail', async () => {
  const p = await pair({ otherDtls:'cc' }); await exchange(p);
  assert.equal(p.a.state.status,'failed'); assert.equal(p.b.state.status,'failed');
  const q = await pair(); await q.a.start(); await q.b.start();
  await q.a.receive(q.bOut[0]); await q.a.receive(q.aOut[1]);
  assert.equal(q.a.state.status,'failed');
});
test('a changed identity cannot replace the selected saved device', async () => {
  const p = await pair(); await exchange(p); await p.a.remember('Galaxy',p.a.state.code);
  const q = await pair({ aStore:p.aStore,expectedId:p.a.state.peerId });
  await exchange(q);
  assert.equal(q.a.state.status,'mismatch'); assert.equal(q.aOut.length,1);
  assert.equal(q.aStore.entries.size,1);
});
test('malformed challenge is bounded, closed sessions send nothing', async () => {
  const p = await pair();
  await p.a.receive({ t:'device-v1',type:'hello',key:'04',nonce:9 });
  assert.equal(p.a.state.status,'failed');
  p.b.close(); await p.b.start(); await p.b.receive(p.aOut[0]);
  assert.equal(p.b.state.status,'closed'); assert.equal(p.bOut.length,0);
  await assert.rejects(openStore(null),/cannot save/);
});
test('missing/ambiguous fingerprints fail before sending identity', async () => {
  const s = await store();
  const base = desc('offer','aa');
  for (const sdp of ['',base.sdp + 'a=fingerprint:sha-256 ' + Array(32).fill('ea').join(':')]) {
    const out = [];
    const session = createSession({pc:{localDescription:{...base,sdp},remoteDescription:desc('answer','bb')},store:s,send:m=>out.push(m)});
    await session.start(); assert.equal(session.state.status,'failed'); assert.equal(out.length,0);
  }
});
test('legacy text is supported, and only explicit http(s) links become links', () => {
  assert.deepEqual(parseFrame({t:'chat',text:'hello'}),{kind:'text',text:'hello',url:null});
  assert.equal(parseFrame(makeFrame('https://example.test','url')).url,'https://example.test/');
  for (const value of ['javascript:alert(1)','data:text/html,hi','file:///a','https://example.test@other.test',
    'https://example.test/\u202ex',' https://example.test','https://a\\b.test']) {
    assert.equal(safeURL(value),null); assert.throws(()=>makeFrame(value,'url'));
  }
  assert.equal(parseFrame({t:'chat',kind:'url',text:'javascript:foo'}).url,null);
  assert.equal(parseFrame({t:'chat',text:'x'.repeat(4001)}),null);
  assert.equal(parseFrame({t:'chat',text:{}}),null);
  assert.deepEqual(makeFrame(' hello\n'),{t:'chat',kind:'text',text:' hello\n'});
});
test('clipboard is explicit, permission denial offers manual fallback', async () => {
  const calls = [];
  const api = { readText: async () => { calls.push('read'); return 'abc'; },
    writeText: async v => { calls.push(v); } };
  assert.equal(await readClipboard(api),'abc'); await copyText('abc',api);
  assert.deepEqual(calls,['read','abc']);
  await assert.rejects(readClipboard({readText:async()=>{throw Error('denied');}}),/Paste/);
  await assert.rejects(copyText('abc',null),/Select/);
});