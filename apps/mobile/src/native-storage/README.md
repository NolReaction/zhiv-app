# Native persistence

The mobile entry calls `initializeNativeStorage(userId?)` before mounting the shared application and on every account transition. Settings hydration and native outbox reads are awaited. A read error does not erase data or silently enter the game with an empty queue.

## Settings

`settings.ts` uses the existing Capacitor Preferences plugin, with the prefix `mochlik.settings.v1.`. The synchronous memory view is installed only after hydration. Writes are serialized and expose pending/error through `getNativeSettingsStatus` / `subscribeNativeSettings`. These are cosmetic settings, not a transactional command queue. `flushNativeSettings()` is a best-effort lifecycle flush, never a guarantee that iOS/Android will keep a suspended process alive.

Current integrations: audio settings, world tap hints, Earth atlas discovery IDs, fishing control hints. No coordinates, passwords, access tokens or server progression are stored through this port. Existing location consent continues to use its synchronous persistence contract; a missing native preference requires a deliberate first lookup.

## Dispatched economic commands

`outbox.ts` and `MochlikStoragePlugin` implement a native SQLite write-ahead journal for dispatched idempotent commands. They do not turn the whole game into an offline client.

1. The HTTP adapter captures the authenticated native account before asynchronous work.
2. Eligible command bodies are validated, canonicalized and saved under native account UUID + gameplay generation + original request UUID.
3. The native SQLite transaction completes before HTTP dispatch starts. A different body cannot reuse the same key.
4. Lost responses, 401, presence handoff, throttling and server failures retain the record. A success requires a matching JSON acknowledgement envelope before cleanup. The feature API separately validates the complete response.
5. On restart only the current native account's records are read. They enter the existing economy receipt interface under the original public owner and gameplay generation. Existing economy reconciliation and its revision checks, presence gating, throttling and idempotency keys remain the sole sender. The storage plugin never sends HTTP itself.
6. Cleanup uses compare-and-delete. If cleanup fails after a server success, the live process suppresses the completed record; a restart may reconcile the same idempotency key again. A late callback cannot delete different data.

Covered paths: economy commands, market commands, neighbor commands, barter commands and friend-market purchases. Unsupported requests, GPS, auth and game-tap batches do not enter this outbox. Native storage contains no session token. The database is excluded from device backups and bounded to 64 records; overflow and malformed records fail closed instead of evicting unconfirmed actions.

Existing unsent production intents, prepared fishing traces, game input/tap journals and other synchronous gameplay journals remain in the WebView's owner/generation-scoped storage. Their save-before-accept semantics have not been replaced by asynchronous fire-and-forget writes. A complete SQLite migration of those journals requires explicitly asynchronous controller and UI acknowledgement contracts.

## Verification

`tests/mobile-native-storage.test.mjs` covers native commit-before-dispatch, process restart, account switch during commit, immutable command IDs, generation separation, uncertain responses, cleanup failure, malformed records, sequential recovery through the real economy session, and serialized settings/error reporting. Those tests use an in-memory implementation of the native database contract. Real SQLite plugins must additionally compile in native CI and be tested on both physical platforms.
