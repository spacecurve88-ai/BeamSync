import { db } from 'hatchable';
import { expireAllRooms } from 'lib/optional-one-scan/lib/quick-pair-store.js';
export const methods = ['POST'];
export const access = 'scheduler';

export default async function (req, res) {
  await expireAllRooms(db);
  return res.json({ok:true});
}
