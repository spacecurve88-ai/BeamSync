'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname,'../..');
const script = fs.readFileSync(path.join(root,'public/js/image-preflight.js'),'utf8');

function preflight() {
  const window = {};
  vm.runInNewContext(script,{window,Blob,Uint8Array,String,Number,Math,Set,Object,Error});
  return window.BeamSyncImagePreflight;
}
function writeText(bytes,offset,value) {
  for (let i=0;i<value.length;i++) bytes[offset+i] = value.charCodeAt(i);
}
function writeU32be(bytes,offset,value) {
  bytes[offset] = value >>> 24; bytes[offset+1] = value >>> 16;
  bytes[offset+2] = value >>> 8; bytes[offset+3] = value;
}
function writeU32le(bytes,offset,value) {
  bytes[offset] = value; bytes[offset+1] = value >>> 8;
  bytes[offset+2] = value >>> 16; bytes[offset+3] = value >>> 24;
}
function png(width,height,{size=8192,type='image/png',animated=false}={}) {
  const bytes = new Uint8Array(size), signature = [137,80,78,71,13,10,26,10];
  bytes.set(signature); let offset = 8;
  writeU32be(bytes,offset,13); writeText(bytes,offset+4,'IHDR');
  writeU32be(bytes,offset+8,width); writeU32be(bytes,offset+12,height);
  bytes[offset+16]=8; bytes[offset+17]=6; offset += 25;
  if (animated) { writeU32be(bytes,offset,8); writeText(bytes,offset+4,'acTL'); offset += 20; }
  writeU32be(bytes,offset,0); writeText(bytes,offset+4,'IDAT');
  return new Blob([bytes],{type});
}
function jpeg(width,height,{size=32768,type='image/jpeg',precision=8}={}) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff,0xd8,0xff,0xc0,0,17,precision,height>>>8,height,width>>>8,width,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xda]);
  return new Blob([bytes],{type});
}
function webp(width,height,{size=8192,type='image/webp',animated=false,frameWidth=width,frameHeight=height}={}) {
  const bytes = new Uint8Array(size);
  writeText(bytes,0,'RIFF'); writeU32le(bytes,4,size-8); writeText(bytes,8,'WEBP');
  writeText(bytes,12,'VP8X'); writeU32le(bytes,16,10); bytes[20]=animated?2:0;
  const w=width-1,h=height-1;
  bytes[24]=w;bytes[25]=w>>>8;bytes[26]=w>>>16;
  bytes[27]=h;bytes[28]=h>>>8;bytes[29]=h>>>16;
  writeText(bytes,30,'VP8L'); writeU32le(bytes,34,5); bytes[38]=0x2f;
  const bits = frameWidth-1 | (frameHeight-1) << 14;
  writeU32le(bytes,39,bits);
  return new Blob([bytes],{type});
}

test('ordinary QR screenshots and camera-photo dimensions pass bounded header inspection',async () => {
  const inspect = preflight().inspect;
  for (const [file,format,width,height] of [
    [png(1080,1920),'png',1080,1920],
    [jpeg(4032,3024),'jpeg',4032,3024],
    [webp(1600,1200),'webp',1600,1200]
  ]) {
    const result = await inspect(file);
    assert.equal(result.format,format); assert.equal(result.width,width); assert.equal(result.height,height);
  }
});

test('oversized and excessive-expansion rasters are rejected from their bounded headers',async () => {
  const inspect = preflight().inspect;
  await assert.rejects(inspect(png(9000,1000,{size:65536})),/no larger than 16 megapixels/);
  await assert.rejects(inspect(png(4000,4000,{size:8192})),/too compressed/);
});

test('unsupported, animated and MIME-mismatched images fail before browser decoding',async () => {
  const inspect = preflight().inspect;
  await assert.rejects(inspect(new Blob(['GIF89a'],{type:'image/gif'})),/PNG, JPEG, or WebP/);
  await assert.rejects(inspect(png(800,600,{type:'image/jpeg'})),/does not match/);
  await assert.rejects(inspect(jpeg(800,600,{precision:12})),/unsupported JPEG/);
  await assert.rejects(inspect(webp(800,600,{animated:true})),/Animated images/);
  await assert.rejects(inspect(webp(800,600,{frameWidth:900})),/inconsistent WebP/);
  await assert.rejects(inspect(png(800,600,{animated:true})),/Animated images/);
});

test('one-scan and offline imports await preflight before invoking browser decoders',() => {
  const ui = fs.readFileSync(path.join(root,'public/ui.js'),'utf8');
  const pairing = fs.readFileSync(path.join(root,'public/js/pairing.js'),'utf8');
  const quick = ui.slice(ui.indexOf('async function readImage'),ui.indexOf("listen('camera-start'"));
  const offline = pairing.slice(pairing.indexOf('async function scanImage'),pairing.indexOf('async function handleScanned'));
  const quickCheck = quick.indexOf('await window.BeamSyncImagePreflight.inspect'), quickDecode = quick.indexOf('image.decode()');
  const offlineCheck = offline.indexOf('await window.BeamSyncImagePreflight.inspect'), offlineDecode = offline.indexOf('createImageBitmap(file)');
  assert.ok(quickCheck >= 0 && quickDecode >= 0 && quickCheck < quickDecode);
  assert.ok(offlineCheck >= 0 && offlineDecode >= 0 && offlineCheck < offlineDecode);
});
