# Titanium WhatsApp linked-device bridge

The bridge is disabled by default in a new installation. Installing an update
does not pair a new device or activate a group. It does not use the browser's
WhatsApp session, copy browser credentials, control a browser, or run commands
from chat messages. The phone remains registered in the normal Business app.

## What is implemented

- A separate Baileys linked device; owner-approved pairing code, once per new
  session. Only the configured account may run; unresolved/mismatched self identity
  stops processing without logging out or deleting anything.
- Durable SQLite authentication (credentials AND Signal keys), inbound queue,
  saved backend response, and bounded reply retry with a persistent outgoing ID.
- Incoming live plain text from explicitly allowlisted registered phone numbers.
  Every group also needs its exact allowlisted JID. Empty group list denies all
  groups. No names, quoted content or phone claims authorize a sender. Unknown
  LIDs fail closed; they are not interpreted as telephone numbers.
- No history/backfill, protocol messages, edits, reactions, forwarded media,
  statuses, broadcasts or own messages. Fresh means after first bridge activation,
  at most five minutes old, with at most one minute of future clock skew.
  Plain extended text may contain a quote; only the new text and a validated
  quoted message ID are forwarded, never the quoted message's contents or sender.
- Maximum twelve accepted messages per registered sender per minute and 1,000
  pending queue rows. Excess messages are ignored; there is no unlimited queue.
- Backend POST retries only for transport errors, HTTP 429 or HTTP 503, at most
  five attempts. Each request has a 30-second timeout to leave room for the
  backend's 12-second inference deadline plus database/result overhead.
  Other HTTP failures stop that row. Replies get at most three
  attempts and never cause the backend operation to execute again.
- Bare six-digit messages using English (`0–9`) or Arabic-Indic (`٠–٩`) digits,
  including mixed digits and surrounding whitespace, are ignored before queueing.
  Enter website login codes on the website. This is a narrow precaution, not a
  general secret detector: codes embedded in sentences or other formats are not
  automatically identified, and ordinary task text containing numbers remains eligible.

## Runtime / pairing prerequisites

Use **Node.js 22.23.2+** (built-in `node:sqlite`), one persistent process,
a durable private local filesystem, and outbound HTTPS/WebSocket access. A normal
serverless request handler or a process tied to this conversation is insufficient.
The VPS must have a supervisor that starts one instance after reboot. Do not run
two instances against the same credentials/database; no multi-process lease is
implemented. Limit supervisor restart loops and surface stopped/failed states.

The package pins `baileys` **7.0.0-rc14** and `pino` 9.6.0. Dependencies were installed
locally with lifecycle scripts disabled and a lockfile generated. Importing the
installed Baileys module without constructing a socket passed. Its actual exports,
JID normalization, SQLite-backed auth serialization and socket factory interface
were checked. This is not a live network or VPS dependency test. Review the
lockfile/audit and verify the installed version before pairing; never downgrade to
an older unpatched release. `whatsapp-rust-bridge` 0.5.4 ships bundled Rust/WASM;
other optional dependencies can include platform-specific binaries.

The known VPS runtime is
`/home/titani24/nodevenv/management.titanium-pharmacy.com/22/bin/node` (22.23.2).
Its default shell `node` is version 16 and MUST NOT run this service. The APIs used
here exist on Node 22.23.2; built-in SQLite no longer needs an enabling flag after
22.13. Local verification used Node 24, so run the offline suite with the explicit
VPS Node 22 executable before deployment. User-level systemd was unavailable on
this host; choose and verify a supported supervisor instead of assuming
`systemctl --user` works. Exit code 78 means configuration/owner attention: do not
blindly restart it indefinitely. Normal SIGTERM/SIGINT uses exit code 0.

Copy the settings from `.env.example` into a private service environment, **not**
the project database, Git, browser or a publicly served file. A service manager
must load them; the application does not load `.env` automatically.

- `TEAM_CHAT_BRIDGE_ENABLED=0` is the safe default.
- `TEAM_CHAT_BOT_NUMBER`: actual management number, international digits only.
- `TEAM_CHAT_ALLOWED_NUMBERS`: actual employee numbers verified against the live
  management user records; do not infer owner/admin status from WhatsApp names.
- `TEAM_CHAT_ALLOWED_GROUPS`: exact group IDs, initially empty for private testing.
- `TEAM_CHAT_STATE_DIR`: an absolute private directory outside this repository and
  all web roots. Protect its parents too; symbolic-link ancestors and Windows ACLs
  require deployment inspection. The database and WAL contain authentication
  secrets and allowed employee message text. They must never be committed to Git.
- `TEAM_CHAT_SHARED_KEY`: a securely generated independent 32-byte secret as 64
  hexadecimal characters, matching the backend. Do not use an example/repeated key.
- `TEAM_CHAT_BACKEND_URL`: the actual HTTPS management endpoint with exact path
  `/api/whatsapp/team-chat`, no credentials/query/fragment or redirects.

Enable the backend only after its permissions/idempotency tests pass. When ready
for an owner-supervised private test, enable this service and set
`TEAM_CHAT_PAIR=1` if no credentials exist. The private service console displays a
new pairing code. The owner enters it in the mobile app's Linked Devices flow.
This is a **new** device; a previous WhatsApp Web pairing is not reused. Set
`TEAM_CHAT_PAIR=0` after success. The credential update and normal socket restart
are persisted; later process restarts reconnect without another code.

Fresh pairing may synchronize identifiers/keys internally, but history is not
forwarded to the task endpoint. Existing browser devices need not be logged out.
For logout, wrong number, forbidden/replaced session, corrupted auth or repeatedly
failed reconnects, the service stops for owner attention; it never erases auth
or silently pairs another account.

## Backend contract

Raw UTF-8 JSON body, retaining the same bytes on retries:

```json
{"messageId":"WA_MESSAGE_ID","senderNumber":"15551234567","groupId":null,"text":"started the task","receivedAt":1800000000000,"responseMessageId":"PREASSIGNED_OUTGOING_ID","replyToMessageId":"OPTIONAL_QUOTED_ID"}
```

The original authenticated group ID replaces null for a group. `receivedAt` is
local ingestion time in Unix milliseconds; the separate WhatsApp source timestamp
has already passed the freshness filter. Header signature:

```text
x-titanium-chat-timestamp: current Unix milliseconds as a decimal string
x-titanium-chat-signature: lowercase hex HMAC-SHA256(
  Buffer.from(TEAM_CHAT_SHARED_KEY, 'hex'), timestamp + '\n' + rawBody
)
```

The backend MUST verify HMAC and timestamp; validate its own active-user phone
mapping and group allowlist; scope durable deduplication by sender, group and
message ID; reject conflicting reused IDs; and commit task changes plus result
atomically. Client-side filters are not a replacement for backend authorization.
The model must never authorize a sender or select arbitrary operations/recipients.
`responseMessageId` is generated once in the durable inbox, signed and reused on
every backend retry and eventual send. `replyToMessageId` is optional and only
references the WhatsApp envelope's quoted stanza ID. The backend must resolve the
reference within the same authenticated sender/group context; it is not authority.

Success is HTTP 200 with `{status: string, reply: string, taskId?: string}`. Empty
reply means remain silent. Extra fields are discarded, particularly recipients.
The reply goes only to the authenticated original chat. Backend-owned templates
and action policies must ensure a group reply does not disclose other users'
private task details. HMAC does not make a compromised bridge host trustworthy;
it authenticates that host, not every possible assertion made by malicious code.

## Secretary groups, privacy and operational controls

`launch-private.mjs` now derives `TEAM_CHAT_AUTH_DATABASE` from the existing private
`WHATSAPP_LOGIN_DATABASE` setting, and a minimal `TEAM_CHAT_AUTH_CONTACTS_JSON`
phone/user mapping from administrator-owned contacts. Contact records explicitly
marked inactive or unverified are excluded from the sender allowlist. Before
processing or delivering task messages, the bridge checks the website's current
`users.active = 1` row. Missing/invalid database authorization fails closed. A
contact phone remap or group allowlist change
still requires a graceful service restart to refresh its startup configuration;
do not pair again or erase session state. Website user deactivation applies
immediately without that restart.

Every group needs its exact allowlisted JID. A fresh WhatsApp metadata query runs
before backend work and again immediately before sending a group reply. Every
participant must resolve unambiguously to the configured bot or an active mapped
website user. Unknown/conflicting LIDs, outsiders, duplicate identities, an
incomplete list, absent bot or an announcement group the bot cannot post to deny
delivery. A membership-change event during the check invalidates it. A short-lived
metadata value used for that send's encryption is **not** an authorization cache;
the previous five-minute authorization/cache path is gone. This is a best-effort
fresh check, not a transactional guarantee against someone joining WhatsApp in
the instant between verification and network delivery.

On privacy failure the sensitive request is failed before any group response.
At most one generic private refusal per sender/group/hour is attempted to the
same currently authorized sender. It contains no roster, group title or task
information. An ambiguous refusal send is not retried.

Replies are bounded plain-text cards: maximum 4,000 JavaScript characters and
16,384 bytes for the whole backend JSON response, no link previews, no arbitrary
response-selected recipients. Unsafe control/bidi override characters are removed.
Native interactive buttons are not implemented or represented as supported.

### Private group discovery/status/one-time introduction

After installing this version, restart the existing single supervised service
once using its existing credentials. Subsequent control requests use the running
socket, not a second login or a second Baileys process. `control.mjs` opens only
the separate private `control.sqlite`, not WhatsApp authentication/session data.

Run with the pinned Node executable from a trusted local server terminal:

```text
node src/control.mjs /absolute/private/existing-state-dir discover "تطوير شركة تيتانيوم"
node src/control.mjs /absolute/private/existing-state-dir result JOB_UUID
node src/control.mjs /absolute/private/existing-state-dir status EXACT_GROUP_JID
node src/control.mjs /absolute/private/existing-state-dir intro EXACT_GROUP_JID
```

`discover` matches only the exact normalized subject. Its result stores matching
group IDs, the requested title and safe membership counts/reasons; unrelated group
names, descriptions and roster numbers are discarded. Multiple exact matches
require the owner to choose the intended one. Discovery does not enable a group,
add members, send an introduction or change private configuration. `status` and
`intro` require an exact allowlisted group. Never infer a group ID from its title.

Each command returns a job ID; fetch its result separately. Jobs expire after
five minutes, have a 15-second execution deadline and are limited to 20 requests
per hour with 20 pending jobs. The fixed introductory message is explicitly queued
and deduplicated per group across process restarts. A failed/ambiguous introduction
is not automatically retried; inspect delivery before any deliberate remediation.
No generic arbitrary-message or arbitrary-recipient command is exposed.

### Explicit user-requested reminders

`SECRETARY_ENABLED=1` in protected configuration enables the independent
`lib/secretary-jobs.ts` worker with the existing website database and sanitized
contacts/groups. No AI key is passed to this worker. The bridge accepts its
`deliverNext(send)` interface; recipient authorization and fresh group privacy
checks still run immediately before send. Its abort signal also bounds a hung
transport call; a send accepted before timeout can have an uncertain outcome.
`TEAM_CHAT_ENABLED=0` pauses secretary/task delivery. The bridge accepts protected
`SECRETARY_WEB_ENABLED` and `SECRETARY_VOICE_ENABLED` settings for shared-config
compatibility, but it does not forward web-search configuration into transport.
With the owner's explicit voice consent, `SECRETARY_ENABLED=1` plus
`SECRETARY_VOICE_ENABLED=1` passes the Groq key only to the server-side, bounded
voice transcriber. Text-only mode still receives no Groq key.

## Free-tier web and voice feasibility (not transport activation)

Official Groq documentation lists free-tier Compound/Compound Mini web-capable
systems and multilingual Whisper models. The exact account quota remains the
console's authority; hitting a free limit returns HTTP 429, not an instruction to
add billing or silently fall back to a paid provider. Compound must remain
separate from the management mutation engine and receive only a public research
query, not staff/task context. The owner has approved voice processing. The voice
path accepts only authenticated fresh PTT Ogg/Opus ≤60seconds and ≤2MiB, validates
the actual container and plaintext hash, uses a pinned WhatsApp CDN with no
redirects, and enforces one15second download/transcription deadline. Audio remains
in memory, is never written to a file, and never becomes an executable command:
the backend requires confirmation for every voice-derived mutation. The private
control database deduplicates voice requests and limits3/minute per sender and
12/minute globally. Live account/API/phone tests are still required separately.

- [Groq free-plan limits](https://console.groq.com/docs/rate-limits)
- [Compound systems and supported built-in tools](https://console.groq.com/docs/compound)
- [Speech-to-text formats and free upload limits](https://console.groq.com/docs/speech-to-text)
- [Groq billing FAQs](https://console.groq.com/docs/billing-faqs)

## Verification and limitations

`npm test` (or `node --test tests/*.test.mjs`) runs offline tests without real
credentials, external requests or employee data. The core `bridge.test.mjs` suite
can run without dependencies installed. The `runtime.test.mjs` suite imports the
installed Baileys package for compatibility checks but replaces its socket factory
with a mock; no real socket is initialized. The combined suite covers
allowlists, PN/LID conflicts, history/spoof-envelope rejection, raw-body HMAC,
SQLite restart persistence, binary auth keys, deduplication and bounded retries,
actual-account pinning, pairing/reconnect lifecycle, and stale-socket event races.
It does **not** certify the live protocol or production readiness.

Required live tests: new phone pairing and correct account; real private message;
one harmless task update plus audit log; duplicate delivery; negative/ambiguous
Arabic; unknown employee; reconnect/reboot; backend rejection; group identity and
privacy before adding an explicit group allowlist. Keep the main site's original
Cloud API webhook disabled/unmodified until the transport decision is explicit.

WhatsApp may accept a reply immediately before a crash or lost acknowledgement.
Retry uses the same outgoing ID, but **exactly-once WhatsApp replies are not
guaranteed**. Backend atomic idempotency is what prevents duplicate task changes.
Sending retry plaintext is available from the queue via `getMessage`.
Failed rows are retained for inspection, not automatically re-executed. Records
currently have no automatic retention purge; set a deliberate retention policy.

This is an unofficial integration, not Meta/OBA approval. Protocol changes may
break it and account restrictions are possible. No guarantee of service uptime,
account safety or permanent free hosting is made.

## Primary references checked

- [Baileys release tags](https://github.com/WhiskeySockets/Baileys/releases)
- [7.0.0-rc14 package source](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/package.json)
- [Maintainer spoofing vulnerability advisory and patched versions](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg)
- [Pairing code](https://baileys.wiki/authentication/pairing-code)
- [Session storage](https://baileys.wiki/authentication/session-management)
- [JIDs and LID mapping](https://baileys.wiki/concepts/jids)
- [Events](https://baileys.wiki/concepts/events)
- [Socket configuration](https://baileys.wiki/concepts/socket-config)
