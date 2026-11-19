import { db } from 'hatchable';
import { roomStore } from 'lib/optional-one-scan/lib/quick-pair-store.js';
export const methods = ['POST'];
export const access = 'scheduler';

export default async function (req, res) {
  await roomStore(db).expire();
  return res.json({ok:true});
}