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
  constructor({pauseFirstInsert=false}={}) {
    this.row = null;
    this.insertCount = 0;
    this.pauseFirstInsert = pauseFirstInsert;
    this.firstInsertStarted = new Promise(resolve => { this.signalFirstInsert = resolve; });
    this.firstInsertGate = new Promise(resolve => { this.releaseFirstInsert = resolve; });
  }
  active() { return this.row && this.row.expiresAt > Date.now(); }
  remaining() { return {rows:[{remaining_ms:Math.max(0,this.row.expiresAt-Date.now())}]}; }
  async query(sql,params) {
    if (sql.startsWith('INSERT INTO')) {
      const insertNumber = ++this.insertCount;
      if (this.pauseFirstInsert && insertNumber === 1) {
        this.signalFirstInsert();
        await this.firstInsertGate;
      }
      assert.match(sql,/expires_at, canceled\)/);
      assert.match(sql,/expires_at = excluded\.expires_at, canceled = FALSE/);
      const expiresAt = Math.min(Date.now()+180000,Date.parse(params[5]));
      if (!this.row && expiresAt > Date.now()) {
        this.row = {slot:params[0],room:params[1],owner:params[2],guest:params[3],offer:params[4],
          answer:null,expiresAt,canceled:false};
        return this.remaining();
      }
      if (this.row.expiresAt <= Date.now() && this.row.room !== params[1] && expiresAt > Date.now()) {
        this.row = {slot:params[0],room:params[1],owner:params[2],guest:params[3],offer:params[4],
          answer:null,expiresAt,canceled:false};
        return this.remaining();
      }
      return {rows:[]};
    }
    if (sql.startsWith('SELECT GREATEST')) {
      assert.match(sql,/canceled = FALSE/);
      const same = this.active() && !this.row.canceled && this.row.slot === params[0] &&
        this.row.room === params[1] && this.row.owner === params[2] && this.row.guest === params[3] &&
        this.row.offer === params[4];
      return same ? this.remaining() : {rows:[]};
    }
    if (sql.startsWith('SELECT offer')) {
      assert.match(sql,/canceled = FALSE/);
      const found = this.active() && !this.row.canceled && this.row.slot === params[0] &&
        this.row.room === params[1] && this.row.guest === params[2] && this.row.answer === null;
      return {rows:found ? [{box:this.row.offer}] : []};
    }
    if (sql.includes('SET answer=$4')) {
      assert.match(sql,/canceled = FALSE/);
      const found = this.active() && !this.row.canceled && this.row.slot === params[0] &&
        this.row.room === params[1] && this.row.guest === params[2] &&
        (this.row.answer === null || this.row.answer === params[3]);
      if (found) this.row.answer = params[3];
      return {rows:found ? [{room:this.row.room}] : []};
    }
    if (sql.startsWith('SELECT answer')) {
      assert.match(sql,/canceled = FALSE/);
      const found = this.active() && !this.row.canceled && this.row.slot === params[0] &&
        this.row.room === params[1] && this.row.owner === params[2];
      return {rows:found ? [{box:this.row.answer}] : []};
    }
    if (sql.includes('SET canceled = TRUE')) {
      assert.doesNotMatch(sql,/DELETE FROM/);
      const found = this.row && this.row.slot === params[0] && this.row.room === params[1] &&
        this.row.owner === params[2];
      if (found) { this.row.canceled = true; this.row.answer = null; }
      return {rows:[]};
    }
    if (sql.startsWith('DELETE FROM')) {
      assert.match(sql,/WHERE expires_at <= clock_timestamp\(\)/);
      if (this.row?.expiresAt <= Date.now()) this.row = null;
      return {rows:[]};
    }
    throw Error('Unexpected query: ' + sql);
  }
}

test('owner cancellation survives a delayed duplicate create',async () => {
  const db = new PairDatabase({pauseFirstInsert:true});
  const rooms = roomStore(db);
  const deadline = Date.now()+180000;
  const delayed = rooms.create(room,owner,guest,offer,deadline);
  await db.firstInsertStarted;
  assert.ok(await rooms.create(room,owner,guest,offer,deadline) > 0);
  await rooms.close(room,owner);
  db.releaseFirstInsert();
  assert.equal(await delayed,null);
  assert.equal(await rooms.offer(room,guest),null);
  assert.equal(await rooms.answer(room,guest,answer),false);
  assert.equal(await rooms.poll(room,owner),null);
  assert.equal(db.row.canceled,true);
});

test('active retries and the normal exchange remain available',async () => {
  const db = new PairDatabase();
  const rooms = roomStore(db);
  assert.ok(await rooms.create(room,owner,guest,offer,Date.now()+120000) > 0);
  const originalExpiry = db.row.expiresAt;
  assert.ok(await rooms.create(room,owner,guest,offer,Date.now()+180000) > 0);
  assert.equal(db.row.expiresAt,originalExpiry);
  assert.deepEqual(await rooms.offer(room,guest),{box:offer});
  assert.equal(await rooms.answer(room,guest,answer),true);
  assert.deepEqual(await rooms.poll(room,owner),{box:answer});
});

test('cleanup retains tombstones through their protected deadline',async () => {
  const db = new PairDatabase();
  const rooms = roomStore(db);
  assert.ok(await rooms.create(room,owner,guest,offer,Date.now()+120000) > 0);
  await rooms.close(room,owner);
  const tombstone = db.row;
  await rooms.expire();
  assert.equal(db.row,tombstone);
  db.row.expiresAt = Date.now()-1;
  await rooms.expire();
  assert.equal(db.row,null);
});

test('both deployed mailboxes receive cancellation state',() => {
  const migration = fs.readFileSync(path.join(root,'migrations/0021_quick_pair_cancellation.sql'),'utf8');
  for (const table of ['beamsync_quick_pair_v14','beamsync_quick_pair_live_v14']) {
    assert.match(migration,new RegExp('ALTER TABLE IF EXISTS '+table+'[\\s\\S]*?canceled boolean NOT NULL DEFAULT false'));
  }
});
