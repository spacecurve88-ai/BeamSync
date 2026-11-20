'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash, webcrypto} = require('node:crypto');
const root = path.resolve(__dirname,'../..');

function load(relative, replacements, exported) {
  let source = fs.readFileSync(path.join(root,relative),'utf8');
  for (const [from,to] of replacements) source = source.replace(from,to);
  const module = {exports:{}};
  vm.runInNewContext(source + `\nmodule.exports={${exported}};`,
    {module,crypto:webcrypto,TextEncoder,Uint8Array,Array,Date,Number,parseInt,Promise});
  return module.exports;
}
const {handlePair} = load('lib/optional-one-scan/lib/quick-pair-handler.js',
  [['export async function handlePair','async function handlePair']],'handlePair');
const {roomStore} = load('lib/optional-one-scan/lib/quick-pair-store.js',
  [['export function expireAllRooms','function expireAllRooms'],['export function roomStore','function roomStore']], 'roomStore');
const digest = value => createHash('sha256').update(value).digest('hex');
const envelope = 'A'.repeat(16) + '.' + 'B'.repeat(23);

function request(owner, headers={}) {
  return {method:'POST',headers:{'content-type':'application/json',...headers},rawBody:Buffer.alloc(200),
    body:{op:'create',room:digest('BeamSync room v1/' + owner).slice(0,32),
      owner,guestHash:'b'.repeat(64),box:envelope}};
}
function response() {
  return {code:200,headers:{},body:null,setHeader(name,value){this.headers[name]=value;},
    status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
}

test('owner variation shares one source quota while another source retains capacity', async () => {
  const active = new Map(), scheduled = [];
  const rooms = {async create(room,owner,guest,box,deadline,source) {
    const count = active.get(source) || 0;
    if (count >= 4) return {remainingMs:null,limited:true};
    active.set(source,count+1);
    return {remainingMs:deadline-Date.now(),limited:false};
  }};
  for (let i=0;i<5;i++) {
    const res = response();
    await handlePair(request(i.toString(16).padStart(64,'0')),res,rooms,d=>scheduled.push(d),true,'203.0.113.7');
    assert.equal(res.code,i < 4 ? 201 : 429);
  }
  const unrelated = response();
  await handlePair(request('f'.repeat(64)),unrelated,rooms,d=>scheduled.push(d),true,'203.0.113.8');
  assert.equal(unrelated.code,201);
  assert.equal(scheduled.length,6);
});

test('trusted source ignores forwarding headers and groups an IPv6 prefix', async () => {
  const sources = [], rooms = {async create(room,owner,guest,box,deadline,source) {
    sources.push(source); return {remainingMs:1000,limited:false};
  }};
  const addresses = ['2001:db8:42:7::1','2001:db8:42:7:ffff::9','::ffff:192.0.2.4','192.0.2.4'];
  for (let i=0;i<addresses.length;i++) {
    const res = response();
    await handlePair(request((i+10).toString(16).padStart(64,'0'),{'x-forwarded-for':'198.51.100.'+i}),
      res,rooms,async()=>{},true,addresses[i]);
    assert.equal(res.code,201);
  }
  assert.equal(sources[0],sources[1]);
  assert.notEqual(sources[1],sources[2]);
  assert.equal(sources[2],sources[3]);
});

test('forwarding headers cannot substitute for the trusted source', async () => {
  let creates = 0, schedules = 0;
  const rooms = {async create(){creates++;return {remainingMs:1000,limited:false};}};
  const res = response();
  await handlePair(request('9'.repeat(64),{'x-forwarded-for':'192.0.2.9'}),res,rooms,
    async()=>{schedules++;},true);
  assert.equal(res.code,429);
  assert.equal(creates,0);
  assert.equal(schedules,0);
});

test('cleanup reservation precedes every admission decision', async () => {
  for (const result of [
    {remainingMs:null,limited:false},
    {remainingMs:null,limited:true}
  ]) {
    const order = [];
    const res = response(), rooms = {async create(){order.push('create');return result;}};
    await handlePair(request('a'.repeat(64)),res,rooms,async()=>{order.push('schedule');},true,'192.0.2.9');
    assert.equal(res.code,result.limited ? 429 : 409);
    assert.deepEqual(order,['schedule','create']);
  }
});

test('an idempotent create retry stays successful with reserved cleanup', async () => {
  let schedules = 0;
  const res = response(), rooms = {async create() {
    return {remainingMs:45000,limited:false};
  }};
  await handlePair(request('d'.repeat(64)),res,rooms,async()=>{schedules++;},true,'192.0.2.10');
  assert.equal(res.code,201);
  assert.equal(res.body.remainingMs,45000);
  assert.equal(schedules,1);
});

test('scheduler failure prevents admission and cancellation', async () => {
  let creates = 0, closes = 0;
  const res = response(), rooms = {
    async create(){creates++;return {remainingMs:90000,limited:false};},
    async close(){closes++;}
  };
  await handlePair(request('e'.repeat(64)),res,rooms,async()=>{throw Error('unavailable');},true,'192.0.2.11');
  assert.equal(res.code,503);
  assert.equal(creates,0);
  assert.equal(closes,0);
});

test('store serializes and counts admission before inserting', async () => {
  let statements;
  const db = {async transaction(queries) {
    statements=queries;
    return [{rows:[{}]},{rows:[{remaining_ms:90000}]},{rows:[{remaining_ms:90000,source_limited:false}]}];
  }};
  const source = 'c'.repeat(64);
  const result = await roomStore(db,true).create('00'.repeat(16),'1'.repeat(64),'2'.repeat(64),envelope,Date.now()+180000,source);
  assert.equal(result.remainingMs,90000);
  assert.equal(result.limited,false);
  assert.equal(statements.length,3);
  assert.match(statements[0].sql,/^SELECT pg_advisory_xact_lock/);
  assert.match(statements[1].sql,/^INSERT INTO beamsync_quick_pair_live_v14/);
  assert.doesNotMatch(statements[1].sql,/\bWITH\b/);
  assert.match(statements[1].sql,/COUNT\(\*\).*source_hash=\$7.*< 4/s);
  assert.match(statements[2].sql,/^SELECT\s+\(SELECT/s);
  assert.equal(statements[0].params[0],source);
  assert.equal(statements[1].params[6],source);
  assert.equal(statements[2].params[5],source);
});

test('store distinguishes retries from exhausted source quotas', async () => {
  const outcomes = [
    {status:{remaining_ms:45000,source_limited:true},expected:{remainingMs:45000,limited:false}},
    {status:{remaining_ms:null,source_limited:true},expected:{remainingMs:null,limited:true}}
  ];
  for (const outcome of outcomes) {
    const db = {async transaction() {
      return [{rows:[{}]},{rows:[]},{rows:[outcome.status]}];
    }};
    const result = await roomStore(db).create('00'.repeat(16),'1'.repeat(64),'2'.repeat(64),
      envelope,Date.now()+180000,'c'.repeat(64));
    assert.equal(result.remainingMs,outcome.expected.remainingMs);
    assert.equal(result.limited,outcome.expected.limited);
  }
});

test('offer lookup remains available without create admission', async () => {
  const res = response(), rooms = {async offer(){return {box:envelope};}};
  const req = {method:'POST',headers:{'content-type':'application/json'},rawBody:Buffer.alloc(100),
    body:{op:'offer',room:'0'.repeat(32),token:'1'.repeat(64)}};
  await handlePair(req,res,rooms,async()=>{throw Error('not used');},true);
  assert.equal(res.code,200);
  assert.equal(res.body.box,envelope);
});
