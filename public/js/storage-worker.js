// The page owns the journal, lease and export lifetime. This worker owns one sync handle.
'use strict';
importScripts('sha256.js' + self.location.search);
const blockSize = 1024 * 1024;
let handle, fileHandle;
// At most 250 entries. These hashes cover the exact ordered buffers supplied to
// the transport's whole-file hash, including the verified prefix after a resume.
const verifiedBlocks = [];
async function checksum(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, v => v.toString(16).padStart(2, '0')).join('');
}
function readBytes(offset, count) {
  const data = new Uint8Array(count);
  let done = 0;
  while (done < count) {
    const n = handle.read(data.subarray(done), {at:offset + done});
    if (!n) throw Error('The saved checkpoint is incomplete. Send this file again.');
    done += n;
  }
  return data;
}
async function run(m) {
  if (m.op === 'open') {
    if (!/^[a-f0-9]{32}$/.test(m.token)) throw Error('Invalid storage filename.');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('beamsync-receive-r1', {create:true});
    try { fileHandle = await dir.getFileHandle(m.token, {create:m.offset === 0}); }
    catch (e) {
      if (e.name === 'NotFoundError' && m.offset) throw Error('The saved checkpoint is missing. Send this file again.');
      throw e;
    }
    handle = await fileHandle.createSyncAccessHandle();
    if (handle.getSize() < m.offset) throw Error('The saved checkpoint is incomplete. Send this file again.');
    if (handle.getSize() > m.offset) {
      handle.truncate(m.offset);
      handle.flush();
    }
    return;
  }
  if (m.op === 'close') {
    if (handle) handle.close();
    handle = null;
    return;
  }
  if (!handle) throw Error('Temporary file is closed.');
  if (m.op === 'append') {
    const data = new Uint8Array(await m.blob.arrayBuffer());
    if (!data.length || data.length > blockSize || handle.getSize() !== m.offset) throw Error('Invalid file offset.');
    const digest = await checksum(data);
    if (m.expected !== undefined && digest !== m.expected) throw Error('The received checkpoint failed verification.');
    let written = 0;
    while (written < data.length) {
      const count = handle.write(data.subarray(written), {at:m.offset + written});
      if (!count) throw new DOMException('Could not write the temporary file.', 'QuotaExceededError');
      written += count;
    }
    handle.flush();
    if (m.offset !== verifiedBlocks.length * blockSize) throw Error('Invalid block order.');
    verifiedBlocks.push(digest);
    return digest;
  }
  if (m.op === 'read') {
    const data = readBytes(m.offset, m.length);
    if (await checksum(data) !== m.expected) throw Error('The saved checkpoint failed verification. Send this file again.');
    if (m.offset !== verifiedBlocks.length * blockSize) throw Error('Invalid checkpoint order.');
    verifiedBlocks.push(m.expected);
    return data;
  }
  if (m.op === 'finish') {
    if (m.size !== handle.getSize()) throw Error('The saved file is incomplete.');
    if (verifiedBlocks.length !== Math.ceil(m.size / blockSize)) throw Error('The saved file is incomplete.');
    // A standalone writer additionally checks the whole-file digest itself.
    // Both modes re-read disk independently before exposing a download.
    const hash = m.streamVerified ? null : new BeamSHA256();
    for (let at = 0; at < m.size; at += blockSize) {
      const bytes = readBytes(at, Math.min(blockSize, m.size - at));
      if (hash) hash.update(bytes);
      else if (await checksum(bytes) !== verifiedBlocks[at / blockSize]) throw Error('The saved file failed verification.');
    }
    if (hash && hash.hex() !== m.expected) throw Error('The saved file failed verification.');
    handle.close();
    handle = null;
    return fileHandle.getFile();
  }
  throw Error('Unknown storage request.');
}
self.onmessage = async ({data}) => {
  try {
    const result = await run(data);
    self.postMessage({result}, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    self.postMessage({failure:{message:error.message, name:error.name}});
  }
};
