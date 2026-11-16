# Native persistence

The mobile entry calls `initializeNativeStorage(userId?)` before mounting the shared application and on every native session transition, including a new session for the same UUID. Settings, command receipts and mutable journals hydrate before shared components mount. Read errors block entry instead of inventing an empty queue. Authentication secrets remain in the native session vault.

## Cosmetic settings

`settings.ts` uses Capacitor Preferences with prefix `mochlik.settings.v1.`. Audio settings, world tap hints, Earth atlas discovery IDs and fishing control hints use a hydrated synchronous memory view. Writes serialize and expose pending/error through `getNativeSettingsStatus` / `subscribeNativeSettings`. These are cosmetic preferences, not a transactional command queue. `flushNativeSettings()` is a best-effort lifecycle flush; suspended or killed apps cannot promise a final callback.

## Dispatched economic commands

`outbox.ts` and `MochlikStoragePlugin` retain a SQLite write-ahead safety net for dispatched idempotent economy, market, neighbor, barter and friend-market purchase commands:

1. Capture the authenticated native account, gameplay generation and original request UUID.
2. Validate and canonicalize the body, commit it before HTTP dispatch; a different body cannot reuse that key.
3. Retain the record on lost responses, 401, presence handoff, throttling and server failures. A matching successful JSON acknowledgement permits compare-and-delete cleanup.
4. On restart expose current-account records to existing economy reconciliation with their original IDs. The storage plugin never sends requests or invents revisions.
5. Failed cleanup can replay the same idempotency key on restart. Live-process suppression and compare-and-delete prevent a late callback deleting another command.

The receipt table is bounded to 64 records and never evicts unconfirmed commands. The existing synchronous economic receipt interface can still mirror the WebView receipt for compatibility; dispatched native requests have an awaited SQLite copy. Unsupported requests and GPS do not enter this transport outbox.

## Mutable client journals

`lib/client-journal-storage.ts` supplies an optional native-only `ClientJournalStorage` port. Browser consumers retain their existing synchronous storage contracts. `journals.ts` implements owner-scoped committed reads plus genuinely awaited SQLite mutations. SQLite schema version 2 adds `journals` without deleting the version 1 receipt table.

- Native account UUID partitions disk rows. Public account IDs and gameplay-generation namespaces partition supported keys inside an account.
- Stable ports are issued per public owner and hydration epoch. A new hydrate retires old ports immediately, waits issued writes, then reads durable rows. Reads and post-commit callbacks reject retired sessions.
- Writes run in FIFO order. Each transaction compares the previous committed string and inserts/replaces/deletes atomically. A concurrent change never gets overwritten blindly.
- Cache state changes only after SQLite commit acknowledgement. A failed or lost native acknowledgement freezes the hydrated view until reopening; consumers cannot treat a Promise as a successful save.
- Bounds are 256 rows, 6 MB UTF-8 per row and 32 MB total; native limits cover all accounts. Exhaustion fails visibly instead of silently evicting pending work.
- Both platforms use WAL and FULL synchronization, and exclude the database from backups. The database is not a replacement for server-authoritative progress.

Covered client data:

| Journal | Acceptance and recovery |
| --- | --- |
| Unsent production intents | Await reservation save before UI acceptance; persist exact request before dispatch and ACK plus remaining queue before the next command. |
| Prepared fishing tickets and terminal traces | Await cast reservation and result saves before local acceptance; keep original command IDs across a lost response. |
| Completed ordinary fishing landing | Await the durable landing before accepting its handoff, including disconnected delivery. |
| Active fishing input checkpoint | Native checkpoint storage restores the same attempt and released controls; terminal handoff waits checkpoint and command acceptance. The rendered local fight remains provisional until saved. |
| Game taps/input | Draft engine mutations become visible and eligible for HTTP only after native commit. Restart preserves original session/sequence; failed writes freeze the last committed snapshot. |
| World and reward pending commands | Await native receipt before dispatch; retain original idempotency identity on uncertain replies. |
| Check-in pending intent | Owner/generation-scoped native receipt before request; retirement prevents an old session completing the new screen. |
| Private location preference | Store only `off`, `ready`, `active`; ON/ACTIVE awaits commit, OFF and restrictions suppress lookup immediately. Reopening interprets old `active` as `ready` until deliberate lookup. |
| Pending privacy restriction | Retain only `OFF`/`GHOST` and its request UUID for retry. No location coordinates or audience are stored in this journal. |

Consumers validate their envelope before replay. Migration reads only the same app's existing WebView storage, with the original owner/generation; it does not import Safari/PWA data. A legacy entry is removed only after the native committed read matches the imported value and the source still matches. Interrupted cleanup can repeat safely. Active unscoped fishing drafts are imported only for gameplay generation zero. Invalid/foreign records are not replayed.

System location permissions remain OS-owned, separate from both user preference and cached coordinates. Background tracking is not enabled by these persistence changes. Other browser caches, UI drafts and server snapshots remain disposable; SQLite journals do not make every game action work offline.

## Verification

`tests/mobile-native-storage.test.mjs` verifies dispatched outbox recovery and cosmetic preference serialization. `tests/mobile-native-client-journals.test.mjs` exercises deferred commits, lost acknowledgements, reopen, account/session retirement, compare-and-swap conflicts, generation isolation, production acceptance, legacy migration and prepared fishing delivery. `tests/mobile-native-game-journal.test.mjs` covers native game input and original sequence recovery. Location and fishing checkpoint suites cover their asynchronous UI contracts.

These tests use the actual TypeScript coordinators with controlled native ports. Native SQLite plugins additionally need native CI compilation and physical iPhone/Android testing, including process termination, permission changes, storage failure and restart while a command is pending.
