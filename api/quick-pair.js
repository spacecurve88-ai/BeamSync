import { db, scheduler } from 'hatchable';
import { handlePair } from 'lib/optional-one-scan/lib/quick-pair-handler.js';
import { roomStore } from 'lib/optional-one-scan/lib/quick-pair-store.js';

export const methods = ['POST'];
export const access = 'public';
const draftHost = 'beamsync-draft.hatchable.site';
const liveHost = 'beamsync.hatchable.site';

export default async function (req, res) {
  const host = typeof req.headers?.host === 'string' ? req.headers.host.toLowerCase() : '';
  // Hatchable's nginx ingress overwrites X-Real-IP from remote_addr. Never trust forwarding chains here.
  const sourceAddress = req.headers?.['x-real-ip'];
  const live = host === liveHost;
  const enabled = (live || host === draftHost) &&
    (req.headers.origin === undefined || req.headers.origin === 'https://' + host);
  const rooms = roomStore(db, live);
  const schedulePrune = async deadline => {
    // One-shot shared by this minute's invites. No permanent schedule and no file content.
    const tick = Math.ceil((deadline + 60000) / 60000);
    await scheduler.at(new Date(tick * 60000), '/api/jobs/quick-pair-expire',
      {name:'beamsync-expire-' + tick, payload:{}});
  };
  return handlePair(req,res,rooms,schedulePrune,enabled,sourceAddress);
}
