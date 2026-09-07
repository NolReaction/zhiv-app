# Backend failure diagnostics

Every API response includes a server-generated UUID in `X-Request-ID`. Error objects of type
`ApiErrorResponse` also include the same optional `requestId` field. Clients should prefer that
field and fall back to the header. Incoming request IDs are ignored, including valid UUIDs;
each attempt gets a fresh ID. Health, readiness, redirects, and Ktor rate-limit responses keep
their existing bodies and receive the header.

Find the `api_failure` event from logger `ru.zhiv.diagnostics` whose `request_id` matches the
reported ID. The existing console output uses SLF4J key-value fields:

| Field | Meaning |
| --- | --- |
| `request_id` | ID returned to the caller |
| `operation`, `method` | Fixed endpoint template and allowlisted HTTP method; path values and queries are omitted |
| `status` | Error-response status, or 302 for a handled provider callback failure |
| `failure_status` | Underlying application/provider failure status; useful when the callback redirects |
| `duration_ms` | Monotonic elapsed processing time at detection; fallback events use response completion time |
| `error_code` | Allowlisted public application code; unrecognized codes become `UNKNOWN_ERROR` |
| `exception_class`, `cause_classes` | Exception types, with a bounded, cycle-safe cause/JDBC-next-exception traversal |
| `source` | At most eight distinct, sanitized application source locations; no exception text |
| `sql_state`, `sql_category` | Valid five-character SQLState and broad failure classification, when available |
| `provider`, `provider_stage`, `provider_http_status` | Fixed provider context and numeric upstream status, when available |

All 5xx responses, provider failures, invalid login codes, auth send/session limits, untrusted
origins, and actual rate-limit rejections are logged. Successes, missing sessions, ordinary
validation, expired/cancelled login flows, and normal check-in/name cooldowns stay quiet.
Exceptions are recorded before producing their error response, so a serialization/send failure
does not erase the original diagnostic; the completion hook avoids duplicate events.

SQLStates `40001`, `40P01`, `55P03`, and `57014` retain the existing `503 DATABASE_BUSY` behavior.
Other SQL failures retain `500 INTERNAL_ERROR`. SQLState categories distinguish concurrency,
connection, integrity, authentication, schema, and resource failures. A readiness probe returning
false logs `503 READINESS_UNAVAILABLE`; the cached boolean probe does not expose its underlying
database exception. `/healthz` continues reporting liveness independently.

Do not add request/response bodies, cookies, authorization headers, email addresses, OTPs,
session/provider tokens, SQL parameters, callback URLs, or raw exception messages to log calls.
`recordApiFailure` sends no Throwable to SLF4J. `%nopex` in `logback.xml` also prevents Logback
from implicitly appending raw exception text. Preserve the providers' `ProviderFailure` cause
wrapper when changing error handling; it retains safe stage and class information without
copying provider payloads. Avoid enabling HTTP/JDBC/SMTP debug payload logging in production.

When adding an endpoint or error code, update the fixed allowlists in `RequestDiagnostics.kt`.
Use `call.recordAuthFailure(failure)` for handled OAuth callback failures after any successful
duplicate-callback recovery branch; its default response status is 302.

Run `./gradlew test` with the project's JDK 25 toolchain. `RequestDiagnosticsTest` covers ID
correlation and spoof rejection, direct and exception error responses, secret redaction,
SQL status behavior, callback diagnostics, readiness, rate-limit headers, expected quiet
responses, and malformed/cyclic exception metadata.
