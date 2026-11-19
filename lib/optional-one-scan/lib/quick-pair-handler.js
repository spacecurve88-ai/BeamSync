const roomID = /^[0-9a-f]{32}$/;
const token = /^[0-9a-f]{64}$/;
const envelope = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,65583}$/;
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x => x.toString(16).padStart(2,'0')).join('');
}
const is = (pattern, value) => typeof value === 'string' && pattern.test(value);
const fields = {
  create: ['op','room','owner','guestHash','box'], offer:['op','room','token'],
  answer: ['op','room','token','box'], poll:['op','room','token'], close:['op','room','token']
};
export async function handlePair(req, res, rooms, schedulePrune, enabled) {
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
      const owner = await hash(b.owner);
      // Reserve cleanup before writing, so a delayed failure cannot undo a successful retry.
      const deadline = Date.now() + 180000;
      await schedulePrune(deadline);
      const remainingMs = await rooms.create(b.room,owner,b.guestHash,b.box,deadline);
      if (remainingMs === null) return fail(409);
      return res.status(201).json({remainingMs});
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
