'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname,'../..');
const storeSource = fs.readFileSync(path.join(root,'lib/optional-one-scan/lib/quick-pair-store.js'),'utf8')
  .replace('export function expireAllRooms','function expireAllRooms')
  .replace('export function roomStore','function roomStore') +
  '\nmodule.exports = {expireAllRooms, roomStore};';
const context = {module:{exports:{}}};
vm.runInNewContext(storeSource,context);
const {roomStore} = context.module.exports;

const room = '00' + '1'.repeat(30);
const owner = '2'.repeat(64);
const guest = '3'.repeat(64);
const offer = 'A'.repeat(16) + '.' + 'B'.repeat(23);
const answer = 'C'.repeat(16) + '.' + 'D'.repeat(23);

class PairDatabase {
  constructor({pauseSecondInsert=false}={}) {
    this.row=null;
    this.insertCount=0;
    this.pauseSecondInsert=pauseSecondInsert;
    this.secondInsertStarted=new Promise(resolve => {this.signalSecondInsert=resolve;});
    this.secondInsertGate=new Promise(resolve => {this.releaseSecondInsert=resolve;});
  }
  active() {return this.row && this.row.expiresAt>Date.now();}
  remaining() {return Math.max(0,this.row.expiresAt-Date.now());}
  async transaction(steps) {
    assert.equal(steps.length,3);
    assert.match(steps[0].sql,/^SELECT pg_advisory_xact_lock/);
    const inserted=await this.query(steps[1].sql,steps[1].params);
    const status=await this.query(steps[2].sql,steps[2].params);
    return {results:[{rows:[{}]},inserted,status]};
  }
  async query(sql,params=[]) {
    if(sql.startsWith('INSERT INTO')) {
      const number=++this.insertCount;
      if(this.pauseSecondInsert && number===2) {
        this.signalSecondInsert();
        await this.secondInsertGate;
      }
      assert.match(sql,/expires_at, canceled, source_hash\)/);
      assert.match(sql,/canceled = FALSE, source_hash = excluded\.source_hash/);
      const expiresAt=Math.min(Date.now()+180000,Date.parse(params[5]));
      const sameSource=this.active() && this.row.source===params[6]?1:0;
      if(sameSource>=4 || expiresAt<=Date.now())return {rows:[]};
      if(!this.row || (this.row.expiresAt<=Date.now() && this.row.room!==params[1])) {
        this.row={slot:params[0],room:params[1],owner:params[2],guest:params[3],
          offer:params[4],answer:null,expiresAt,canceled:false,source:params[6]};
        return {rows:[{remaining_ms:this.remaining()}]};
      }
      return {rows:[]};
    }
    if(sql.includes('AS source_limited')) {
      assert.match(sql,/canceled = FALSE/);
      const valid=this.active()&&!this.row.canceled&&this.row.slot===params[0] &&
        this.row.room===params[1]&&this.row.owner===params[2]&&this.row.guest===params[3] &&
        this.row.offer===params[4];
      const count=this.active()&&this.row.source===params[5]?1:0;
      return {rows:[{remaining_ms:valid?this.remaining():null,source_limited:count>=4}]};
    }
    if(sql.startsWith('SELECT offer')) {
      assert.match(sql,/canceled = FALSE/);
      const valid=this.active()&&!this.row.canceled&&this.row.slot===params[0] &&
        this.row.room===params[1]&&this.row.guest===params[2]&&this.row.answer===null;
      return {rows:valid?[{box:this.row.offer}]:[]};
    }
    if(sql.includes('SET answer=$4')) {
      assert.match(sql,/canceled = FALSE/);
      const valid=this.active()&&!this.row.canceled&&this.row.slot===params[0] &&
        this.row.room===params[1]&&this.row.guest===params[2] &&
        (this.row.answer===null||this.row.answer===params[3]);
      if(valid)this.row.answer=params[3];
      return {rows:valid?[{room:this.row.room}]:[]};
    }
    if(sql.startsWith('SELECT answer')) {
      assert.match(sql,/canceled = FALSE/);
      const valid=this.active()&&!this.row.canceled&&this.row.slot===params[0] &&
        this.row.room===params[1]&&this.row.owner===params[2];
      return {rows:valid?[{box:this.row.answer}]:[]};
    }
    if(sql.includes('SET canceled = TRUE')) {
      assert.doesNotMatch(sql,/DELETE FROM/);
      const valid=this.row&&this.row.slot===params[0]&&this.row.room===params[1]&&this.row.owner===params[2];
      if(valid){this.row.canceled=true;this.row.answer=null;}
      return {rows:[]};
    }
    if(sql.startsWith('DELETE FROM')) {
      assert.match(sql,/WHERE expires_at <= clock_timestamp\(\)/);
      if(this.row?.expiresAt<=Date.now())this.row=null;
      return {rows:[]};
    }
    throw Error('Unexpected query: '+sql.slice(0,90));
  }
}

test('owner cancellation survives a delayed authenticated create',async () => {
  const db=new PairDatabase({pauseSecondInsert:true});
  const rooms=roomStore(db),source='c'.repeat(64);
  const deadline=Date.now()+180000;
  assert.ok((await rooms.create(room,owner,guest,offer,deadline,source)).remainingMs>0);
  const delayed=rooms.create(room,owner,guest,offer,deadline,source);
  await db.secondInsertStarted;
  await rooms.close(room,owner);
  db.releaseSecondInsert();
  assert.equal((await delayed).remainingMs,null);
  assert.equal(await rooms.offer(room,guest),null);
  assert.equal(await rooms.answer(room,guest,answer),false);
  assert.equal(await rooms.poll(room,owner),null);
  assert.equal(db.row.canceled,true);
});

test('active retries and the normal exchange remain available',async () => {
  const db = new PairDatabase();
  const rooms = roomStore(db);
  assert.ok(await (await rooms.create(room,owner,guest,offer,Date.now()+120000,'c'.repeat(64))).remainingMs > 0);
  const originalExpiry = db.row.expiresAt;
  assert.ok(await (await rooms.create(room,owner,guest,offer,Date.now()+180000,'c'.repeat(64))).remainingMs > 0);
  assert.equal(db.row.expiresAt,originalExpiry);
  assert.deepEqual(await rooms.offer(room,guest),{box:offer});
  assert.equal(await rooms.answer(room,guest,answer),true);
  assert.deepEqual(await rooms.poll(room,owner),{box:answer});
});

test('cleanup retains tombstones through their protected deadline',async () => {
  const db = new PairDatabase();
  const rooms = roomStore(db);
  assert.ok(await (await rooms.create(room,owner,guest,offer,Date.now()+120000,'c'.repeat(64))).remainingMs > 0);
  await rooms.close(room,owner);
  const tombstone = db.row;
  await rooms.expire();
  assert.equal(db.row,tombstone);
  db.row.expiresAt = Date.now()-1;
  await rooms.expire();
  assert.equal(db.row,null);
});

test('both deployed mailboxes receive cancellation state',() => {
  const migration = fs.readFileSync(path.join(root,'migrations/0022_quick_pair_cancellation.sql'),'utf8');
  for (const table of ['beamsync_quick_pair_v14','beamsync_quick_pair_live_v14']) {
    assert.match(migration,new RegExp('ALTER TABLE IF EXISTS '+table+'[\\s\\S]*?canceled boolean NOT NULL DEFAULT false'));
  }
});
