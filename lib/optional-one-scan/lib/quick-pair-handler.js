const roomID = /^[0-9a-f]{32}$/;
const token = /^[0-9a-f]{64}$/;
const envelope = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,65583}$/;
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x => x.toString(16).padStart(2,'0')).join('');
}
const is = (pattern, value) => typeof value === 'string' && pattern.test(value);
function ipv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}
function sourceBucket(input) {
  if (typeof input !== 'string' || input.length > 80) return null;
  const value = input.trim().toLowerCase().split('%',1)[0];
  const v4 = ipv4(value);
  if (v4) return 'v4/' + v4.join('.');
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const words = side => {
    if (!side) return [];
    const parts = side.split(':'), result = [];
    for (let i = 0; i < parts.length; i++) {
      if (/^[0-9a-f]{1,4}$/.test(parts[i])) result.push(parseInt(parts[i],16));
      else {
        const tail = i === parts.length - 1 ? ipv4(parts[i]) : null;
        if (!tail) return null;
        result.push((tail[0] << 8) | tail[1], (tail[2] << 8) | tail[3]);
      }
    }
    return result;
  };
  const left = words(halves[0]), right = words(halves[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const full = [...left,...Array(missing).fill(0),...right];
  if (full.length !== 8) return null;
  if (full.slice(0,5).every(word => word === 0) && full[5] === 0xffff)
    return 'v4/' + [full[6] >> 8,full[6] & 255,full[7] >> 8,full[7] & 255].join('.');
  // A single IPv6 subscriber can rotate interface addresses, so meter the stable /64 prefix.
  return 'v6/' + full.slice(0,4).map(word => word.toString(16).padStart(4,'0')).join(':');
}
const fields = {
  create: ['op','room','owner','guestHash','box'], offer:['op','room','token'],
  answer: ['op','room','token','box'], poll:['op','room','token'], close:['op','room','token']
};
export async function handlePair(req, res, rooms, schedulePrune, enabled, sourceAddress) {
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  const fail = code => res.status(code).json({error:'Pairing request unavailable.'});
  if (!enabled) return fail(404);
  if (req.method !== 'POST') return fail(405);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') ||
      ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) return fail(403);
  if ((req.rawBody?.length || 0) > 66000) return fail(413);
  const b = req.body;
  if (!b || typeof b !== 'object' || typeof b.op !== 'string' || !Object.prototype.hasOwnProperty.call(fields,b.op) ||
      !is(roomID,b.room) || Object.keys(b).some(key => !fields[b.op].includes(key)) ||
      (fields[b.op].includes('box') && !is(envelope,b.box))) return fail(400);
  try {
    if (b.op === 'create') {
      if (!is(token,b.owner) || !is(token,b.guestHash)) return fail(400);
      // A guest with an old QR cannot reopen that room after deletion. Only the host knows its preimage.
      if ((await hash('BeamSync room v1/' + b.owner)).slice(0,32) !== b.room) return fail(400);
      const source = sourceBucket(sourceAddress);
      if (!source) return fail(429);
      const [owner,sourceHash] = await Promise.all([hash(b.owner),hash('BeamSync source v1/' + source)]);
      const deadline = Date.now() + 180000;
      // Reserve cleanup before writing, so a delayed failure cannot undo a successful retry.
      await schedulePrune(deadline);
      const created = await rooms.create(b.room,owner,b.guestHash,b.box,deadline,sourceHash);
      if (created.limited) return fail(429);
      if (created.remainingMs === null) return fail(409);
      return res.status(201).json({remainingMs:created.remainingMs});
    }
    if (!is(token,b.token)) return fail(400);
    const credential = await hash(b.token);
    if (b.op === 'offer' || b.op === 'poll') {
      const row = await rooms[b.op](b.room,credential);
      return row ? res.json({box:row.box}) : fail(404);
    }
    if (b.op === 'answer' && !(await rooms.answer(b.room,credential,b.box))) return fail(404);
    if (b.op === 'close') await rooms.close(b.room,credential);
    return res.json({ok:true});
  } catch { return fail(503); } // Never echo raw SDP, URLs, tokens or database errors.
}
