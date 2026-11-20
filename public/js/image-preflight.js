(()=>{
'use strict';

const HEADER_LIMIT = 512 * 1024;
const MAX_ENCODED_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16 * 1000 * 1000;
const MAX_DECODE_RATIO = 2048;
const formats = {
  png: new Set(['image/png','image/x-png']),
  jpeg: new Set(['image/jpeg','image/jpg','image/pjpeg']),
  webp: new Set(['image/webp'])
};

function fail(message) {
  const error = Error(message);
  error.name = 'ImagePreflightError';
  throw error;
}
function ascii(bytes,offset,length) {
  let value = '';
  for (let i=0;i<length;i++) value += String.fromCharCode(bytes[offset+i]);
  return value;
}
function u16be(bytes,offset) { return bytes[offset] * 256 + bytes[offset+1]; }
function u16le(bytes,offset) { return bytes[offset] + bytes[offset+1] * 256; }
function u24le(bytes,offset) { return bytes[offset] + bytes[offset+1] * 256 + bytes[offset+2] * 65536; }
function u32be(bytes,offset) { return bytes[offset] * 16777216 + bytes[offset+1] * 65536 + bytes[offset+2] * 256 + bytes[offset+3]; }
function u32le(bytes,offset) { return bytes[offset] + bytes[offset+1] * 256 + bytes[offset+2] * 65536 + bytes[offset+3] * 16777216; }

function pngDimensions(bytes) {
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.length < 33 || !signature.every((value,index) => bytes[index] === value)) return null;
  let offset = 8, width = 0, height = 0, sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes,offset);
    const type = ascii(bytes,offset+4,4);
    const dataOffset = offset + 8;
    if (type === 'IDAT') {
      if (!sawHeader) fail('This QR image has an invalid PNG header.');
      return {format:'png',width,height};
    }
    if (length > HEADER_LIMIT || dataOffset + length + 4 > bytes.length) {
      fail('This QR image header is too large to inspect safely.');
    }
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) fail('This QR image has an invalid PNG header.');
      width = u32be(bytes,dataOffset);
      height = u32be(bytes,dataOffset+4);
      const depth = bytes[dataOffset+8], color = bytes[dataOffset+9];
      const validDepths = {0:[1,2,4,8],2:[8],3:[1,2,4,8],4:[8],6:[8]};
      if (!validDepths[color]?.includes(depth) || bytes[dataOffset+10] !== 0 ||
          bytes[dataOffset+11] !== 0 || bytes[dataOffset+12] > 1) {
        fail('This QR image has an unsupported PNG header.');
      }
      sawHeader = true;
    } else if (type === 'IHDR') fail('This QR image has an invalid PNG header.');
    if (type === 'acTL') fail('Animated images cannot be used as QR images.');
    if (type === 'IEND') fail('This QR image has no readable PNG pixels.');
    offset = dataOffset + length + 4;
  }
  fail('This QR image header is too large to inspect safely.');
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const acceptedFrames = new Set([0xc0,0xc2]);
  const allFrames = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2, frame = null;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail('This QR image has an invalid JPEG header.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xda) {
      if (!frame) fail('This QR image has no readable JPEG frame.');
      return {format:'jpeg',width:frame.width,height:frame.height};
    }
    if (marker === 0xd9) fail('This QR image has no readable JPEG pixels.');
    if (marker === 0x01 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = u16be(bytes,offset);
    if (length < 2 || offset + length > bytes.length) {
      fail('This QR image header is too large to inspect safely.');
    }
    if (allFrames.has(marker)) {
      if (!acceptedFrames.has(marker)) fail('Choose a baseline or progressive JPEG QR image.');
      if (frame || length < 11) fail('This QR image has an invalid JPEG frame.');
      const components = bytes[offset+7];
      if (bytes[offset+2] !== 8 || ![1,3,4].includes(components) || length !== 8 + components * 3) {
        fail('This QR image has an unsupported JPEG frame.');
      }
      frame = {height:u16be(bytes,offset+3),width:u16be(bytes,offset+5)};
    }
    offset += length;
  }
  fail('This QR image header is too large to inspect safely.');
}

function webpFrameDimensions(bytes,chunk,length,dataOffset) {
  if (chunk === 'VP8 ') {
    if (length < 10 || bytes.length < dataOffset + 10 || bytes[dataOffset] & 1 ||
        bytes[dataOffset+3] !== 0x9d || bytes[dataOffset+4] !== 0x01 || bytes[dataOffset+5] !== 0x2a) {
      fail('This QR image has an invalid WebP frame.');
    }
    return {width:u16le(bytes,dataOffset+6)&0x3fff,height:u16le(bytes,dataOffset+8)&0x3fff};
  }
  if (chunk === 'VP8L') {
    if (length < 5 || bytes.length < dataOffset + 5 || bytes[dataOffset] !== 0x2f) {
      fail('This QR image has an invalid WebP frame.');
    }
    const bits = (u32le(bytes,dataOffset+1) >>> 0);
    return {width:(bits & 0x3fff)+1,height:((bits >>> 14) & 0x3fff)+1};
  }
  return null;
}

function webpDimensions(bytes,fileSize) {
  if (bytes.length < 20 || ascii(bytes,0,4) !== 'RIFF' || ascii(bytes,8,4) !== 'WEBP') return null;
  if (u32le(bytes,4) + 8 !== fileSize) fail('This QR image has an invalid WebP container.');
  let offset = 12, chunk = ascii(bytes,offset,4), length = u32le(bytes,offset+4), dataOffset = offset + 8;
  if (dataOffset + length + (length & 1) > fileSize) fail('This QR image has an invalid WebP container.');
  const simple = webpFrameDimensions(bytes,chunk,length,dataOffset);
  if (simple) return {format:'webp',...simple};
  if (chunk !== 'VP8X' || length !== 10 || bytes.length < 30 || bytes[dataOffset] & 0xc1) {
    fail('This QR image has an invalid WebP header.');
  }
  if (bytes[dataOffset] & 0x02) fail('Animated images cannot be used as QR images.');
  const canvas = {width:u24le(bytes,dataOffset+4)+1,height:u24le(bytes,dataOffset+7)+1};
  offset = 30;
  while (offset + 8 <= bytes.length) {
    chunk = ascii(bytes,offset,4); length = u32le(bytes,offset+4); dataOffset = offset + 8;
    const next = dataOffset + length + (length & 1);
    if (next > fileSize) fail('This QR image has an invalid WebP container.');
    if (chunk === 'ANIM' || chunk === 'ANMF') fail('Animated images cannot be used as QR images.');
    const frame = webpFrameDimensions(bytes,chunk,length,dataOffset);
    if (frame) {
      if (frame.width !== canvas.width || frame.height !== canvas.height) {
        fail('This QR image has inconsistent WebP dimensions.');
      }
      return {format:'webp',...canvas};
    }
    if (next > bytes.length) fail('This QR image header is too large to inspect safely.');
    offset = next;
  }
  fail('This QR image header is too large to inspect safely.');
}

async function inspect(file,{maxBytes=MAX_ENCODED_BYTES,sizeMessage='Choose a QR image under 20 MiB.'}={}) {
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes,MAX_ENCODED_BYTES) : MAX_ENCODED_BYTES;
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > byteLimit ||
      typeof file.slice !== 'function') fail(sizeMessage);
  const bytes = new Uint8Array(await file.slice(0,Math.min(file.size,HEADER_LIMIT)).arrayBuffer());
  const info = pngDimensions(bytes) || jpegDimensions(bytes) || webpDimensions(bytes,file.size);
  if (!info) fail('Choose a PNG, JPEG, or WebP QR image.');
  const mime = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (mime && !formats[info.format].has(mime)) fail('The QR image type does not match its file contents.');
  const {width,height} = info, pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || pixels > MAX_PIXELS) {
    fail('Choose a QR image no larger than 16 megapixels and 8192 pixels per side.');
  }
  if (pixels * 4 > file.size * MAX_DECODE_RATIO) {
    fail('This QR image is too compressed to inspect safely.');
  }
  return Object.freeze(info);
}

window.BeamSyncImagePreflight = Object.freeze({inspect});
})();
