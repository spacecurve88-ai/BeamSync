# One-scan pairing

The receiver scans one HTTPS invitation and confirms it. The sender gathers connection information, encrypts it in the browser and stores an offer with the existing Hatchable project. The receiver fetches the offer, verifies it and posts an encrypted answer. The sender removes the mailbox after applying that answer. The two browsers then share content over their WebRTC data channel. LAN mode uses no STUN service. Cross-network mode uses the same STUN configuration as classic BeamSync. There is no TURN server.

## Approval and release

The browser flag is a meta element named `beamsync-one-scan` with content `enabled`. An absent flag, or any other value, disables Quick Pair. The API also has its own `enabled` release constant in `api/quick-pair.js`, initially false. Keep both off until the project owner approves the new signaling boundary. This feature does not need a visibility change to the project. Both devices still need existing access to the project on their own browser. An invitation omits any Hatchable preview or login credentials.

The optional server consists of the two `api/` routes, two shared `lib/` modules, and the additive `migrations/0014_quick_pair.sql`. Its table is separate from the existing v13 table. The public HTTP route remains behind the existing project's visibility rules. The purge route accepts only platform scheduler calls. The one-shot scheduler calls and HTTP traffic consume the project's available allowance. Verify the allowance and test actual invocation, database, and scheduler behavior before enabling either production flag. The app provides a local QR alternative when the service is unreachable or busy.

To turn Quick Pair off, restore the two disabled flags, redeploy the last validated release, and keep the cleanup function available until every outstanding room has expired and been swept. Rollback of the app does not remove tables. If deployment removes the scheduler endpoint early, inspect the dedicated v14 table and restore the cleanup handler to remove only expired v14 rooms. No v13 or unrelated table needs to change.

## Data and retention

A QR carries a 128-bit room identifier bound to the sender and a 256-bit random encryption key in its URI fragment. Its holder can participate until the invite expires or someone submits the answer. Keep it between the two devices. The receiver removes the fragment from its visible URL and history entry on load. OS camera and clipboard software can retain a copy. Sharing a QR gives the recipient permission to attempt pairing. Files still need a separate acceptance step.

The service receives random room identifiers, access tokens and encrypted session descriptions. The database stores one-way hashes of role tokens. The guest token cannot close a room or read the sender's answer, and cannot reclaim an old room. AES-GCM authenticates each offer and answer with a random 96-bit IV and associated data naming the room and message direction. Normal HTTP infrastructure can see client IPs, access times, ciphertext size, and that two devices used the same room. The application does not record tokens, decrypted descriptions, file bytes, names, messages, or persistent device identities on the server. The host that supplies the web application remains trusted for the JavaScript it delivers.

The server rejects reads and writes at three minutes, independently of either device's clock. Receiving one valid answer locks the mailbox against competing replies. The sender attempts immediate deletion after applying an answer and on reset. Expired ciphertext can stay on the server until its scheduled cleanup actually runs. A failed cleanup can leave inaccessible rows until a later sweep or slot reuse. Physical deletion timing and platform backup/log retention were not verified. The dedicated table can hold at most 64 rows. When all slots are busy a sender gets a recoverable error. A guest in possession of the QR can race the intended receiver, so the operator should scan only their own device's QR.

## Validation

Run `node --test tests/signaling.test.cjs` from this component using Node 24. The tests use browser WebCrypto and execute the production queries on SQLite with translated PostgreSQL time expressions. They exercise encryption, key and role separation, malformed input, expiry, retries, capacity, and cleanup. PostgreSQL and Hatchable are independent integration checks.

Before release, verify creation and a complete exchange through the real approved route, owner-only deletion, first-answer reservation, access denial on a reused QR, and the scheduler's removal of one purposely abandoned room. Test the public-facing site with the actual access method both devices use. Exercise iPad Safari ↔ Android Chrome, both directions, with the OS Camera, a common LAN, and a different-network attempt. Some mobile network pairs require a TURN relay. The release contains none.
