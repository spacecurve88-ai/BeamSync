import { db } from 'hatchable';

export const access = 'public';

const ROLES = new Set(['offer','answer','restart_offer','restart_answer']);
const ROOM_RE = /^[a-f0-9]{32}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const op = body?.op;
  const roomId = String(body?.roomId || '').toLowerCase();
  const role = String(body?.role || '');
  if (!ROOM_RE.test(roomId)) return json({ error: 'invalid_room' }, 400);

  await db.query('DELETE FROM beamsync_signals WHERE expires_at <= NOW()');

  if (op === 'put') {
    if (!ROLES.has(role)) return json({ error: 'invalid_role' }, 400);
    const payload = String(body?.payload || '');
    if (payload.length < 20 || payload.length > 65536) return json({ error: 'invalid_payload' }, 400);
    const ttl = Math.max(60, Math.min(900, Number(body?.ttlSeconds) || 600));
    await db.query(
      `INSERT INTO beamsync_signals (room_id, role, payload, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'), NOW())
       ON CONFLICT (room_id, role)
       DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [roomId, role, payload, ttl]
    );
    return json({ ok: true });
  }

  if (op === 'get') {
    if (!ROLES.has(role)) return json({ error: 'invalid_role' }, 400);
    const result = await db.query(
      'SELECT payload FROM beamsync_signals WHERE room_id = $1 AND role = $2 AND expires_at > NOW() LIMIT 1',
      [roomId, role]
    );
    return json({ ok: true, payload: result.rows?.[0]?.payload || null });
  }

  if (op === 'clear') {
    await db.query('DELETE FROM beamsync_signals WHERE room_id = $1', [roomId]);
    return json({ ok: true });
  }

  return json({ error: 'invalid_operation' }, 400);
}