// Each host has 64 independent slots. Table names come only from these constants.
const draftTable = 'beamsync_quick_pair_v14';
const liveTable = 'beamsync_quick_pair_live_v14';
const remaining = 'GREATEST(0, floor(extract(epoch from (expires_at - clock_timestamp())) * 1000)) AS remaining_ms';
const slotFor = room => parseInt(room.slice(0, 2), 16) % 64;
const expiredRows = table => `DELETE FROM ${table} WHERE expires_at <= clock_timestamp()`;

export function expireAllRooms(db) {
  // Jobs issued by earlier builds have an empty payload. Every job cleans both tables.
  // Wait for in-flight writes, and exclude new writes until both snapshots have been swept.
  return db.transaction([
    {sql:`LOCK TABLE ${draftTable}, ${liveTable} IN SHARE ROW EXCLUSIVE MODE`, params:[]},
    ...[draftTable, liveTable].map(table => ({sql:expiredRows(table), params:[]}))
  ]);
}

export function roomStore(db, live = false) {
  const table = live === true ? liveTable : draftTable;
  return {
    async create(room, ownerHash, guestHash, box, deadline) {
      const result = await db.query(`INSERT INTO ${table} (slot, room, owner_hash, guest_hash, offer, expires_at)
        SELECT $1, $2, $3, $4, $5, LEAST(clock_timestamp() + interval '3 minutes', $6::timestamptz)
        WHERE $6::timestamptz > clock_timestamp()
        ON CONFLICT (slot) DO UPDATE SET room = excluded.room, owner_hash = excluded.owner_hash,
          guest_hash = excluded.guest_hash, offer = excluded.offer, answer = NULL, expires_at = excluded.expires_at
        WHERE ${table}.expires_at <= clock_timestamp() AND ${table}.room <> excluded.room
          AND excluded.expires_at > clock_timestamp()
        RETURNING ${remaining}`, [slotFor(room),room,ownerHash,guestHash,box,new Date(deadline).toISOString()]);
      if (result.rows[0]) return Number(result.rows[0].remaining_ms);
      // An identical retry is safe after a lost response. It cannot extend the original expiry.
      const previous = await db.query(`SELECT ${remaining} FROM ${table}
        WHERE slot=$1 AND room=$2 AND owner_hash=$3 AND guest_hash=$4 AND offer=$5 AND expires_at > clock_timestamp()`,
        [slotFor(room),room,ownerHash,guestHash,box]);
      return previous.rows[0] ? Number(previous.rows[0].remaining_ms) : null;
    },
    async offer(room, hash) {
      const found = await db.query(`SELECT offer AS box FROM ${table} WHERE slot=$1 AND room=$2
        AND guest_hash=$3 AND expires_at > now() AND answer IS NULL`, [slotFor(room),room,hash]);
      return found.rows[0] ?? null;
    },
    async answer(room, hash, box) {
      const found = await db.query(`UPDATE ${table} SET answer=$4 WHERE slot=$1 AND room=$2
        AND guest_hash=$3 AND expires_at > now() AND (answer IS NULL OR answer=$4) RETURNING room`,
        [slotFor(room),room,hash,box]);
      return found.rows.length > 0;
    },
    async poll(room, hash) {
      const found = await db.query(`SELECT answer AS box FROM ${table} WHERE slot=$1 AND room=$2
        AND owner_hash=$3 AND expires_at > now()`, [slotFor(room),room,hash]);
      return found.rows[0] ?? null;
    },
    async close(room, hash) {
      await db.query(`DELETE FROM ${table} WHERE slot=$1 AND room=$2 AND owner_hash=$3`, [slotFor(room),room,hash]);
    },
    async expire() { await db.query(expiredRows(table)); }
  };
}
