import { db, scheduler } from 'hatchable';
import { handlePair } from 'lib/optional-one-scan/lib/quick-pair-handler.js';
import { roomStore } from 'lib/optional-one-scan/lib/quick-pair-store.js';

export const methods = ['POST'];
export const access = 'public';
// Release flag. The route must fail closed even if a caller bypasses the UI.
const enabled = false;

export default async function (req, res) {
  const rooms = roomStore(db);
  const schedulePrune = async () => {
    // One-shot shared by this minute's invites. No permanent schedule and no file content.
    const tick = Math.ceil((Date.now() + 240000) / 60000);
    await scheduler.at(new Date(tick * 60000), '/api/jobs/quick-pair-expire',
      {name:'beamsync-expire-' + tick, payload:{}});
  };
  return handlePair(req,res,rooms,schedulePrune,enabled);
}