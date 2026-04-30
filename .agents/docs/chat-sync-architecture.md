# Chat Sync Architecture

This document records the target architecture for making InfChat message delivery reliable. It is intentionally a rebuild plan, not a patch list.

## Goal

Messages may arrive late, but they must not be lost. Sync hints may be duplicated, but messages must not render twice. The app may go offline, be killed, or miss realtime events, but it must converge to the server's authoritative state.

## Core Principles

- The server is the only source of truth.
- SQLite is the only canonical client-side chat store.
- React Query is a selector/invalidation layer, not a chat data source of truth.
- Push notifications and realtime events are wake-up hints only.
- All sync paths go through one `ChatSyncService`.
- Client clocks are never used for ordering or read correctness.
- Cursor advancement and local row writes must commit in the same SQLite transaction.
- Outgoing messages live in a durable outbox before any network request starts.

## Server Protocol

Add a real chat protocol layer instead of relying on raw collection CRUD for core delivery.

### Required Collections and Fields

`messages` additions:

- `message_seq`: monotonic per-conversation sequence.
- `client_message_id`: durable client idempotency key.
- `sender_device_id`: sending device identity.
- `deleted_at`: soft-delete/tombstone marker.
- `edited_at`: edit timestamp for display only.
- `edit_version`: monotonic edit version.

`conversations` additions:

- `next_message_seq`: next assignable message sequence.
- `last_message_id`: canonical preview message.
- `last_message_seq`: canonical preview sequence.
- `last_change_cursor`: latest sync cursor affecting the conversation.

New `conversation_user_states`:

- `conversation`
- `user`
- `last_read_seq`
- `unread_count`
- `last_delivered_cursor`

New `sync_events`:

- `cursor`
- `user`
- `conversation`
- `type`
- `entity_id`
- `payload`
- `created`

New `idempotency_keys`:

- `user`
- `device_id`
- `client_message_id`
- `payload_hash`
- `message_id`
- `result_cursor`

New `push_outbox`:

- `user`
- `conversation`
- `cursor`
- `payload`
- `status`
- `attempt_count`
- `next_attempt_at`
- `last_error`

### Required Endpoints

- `POST /api/infchat/messages/send`
- `POST /api/infchat/conversations/:id/read`
- `GET /api/infchat/bootstrap`
- `GET /api/infchat/sync?cursor=&limit=`
- `GET /api/infchat/conversations/:id/messages?beforeSeq=&limit=`

### Message Send Transaction

`POST /messages/send` must atomically:

1. Authenticate and authorize conversation membership.
2. Normalize and validate message payload.
3. Check `(user, device_id, client_message_id)` idempotency.
4. Assign `message_seq` from `conversations.next_message_seq`.
5. Create the message.
6. Update conversation preview if the new message is latest.
7. Update each member's `conversation_user_states`.
8. Append per-user `sync_events`.
9. Enqueue `push_outbox` rows.
10. Commit, then let a worker send push notifications.

If a request is retried with the same idempotency key and identical payload, return the original result. If the payload differs, return a conflict.

### Read Receipts

Read state is based on message sequence, not timestamps.

- Client sends the highest actually visible `message_seq`.
- Server verifies the sequence is valid for the conversation.
- Server only allows monotonic advancement.
- Unread count is derived or maintained from `last_read_seq` and non-self messages.

### Sync Events

Every user-visible mutation creates durable per-user sync events. Realtime and push include only sync hints, for example:

```json
{ "type": "sync_hint", "conversationId": "...", "latestCursor": 123 }
```

The client must always call sync to catch up. Event delivery is not correctness-critical.

## Client Architecture

### Local Store

Create a new schema-versioned SQLite replica. Old chat cache can be wiped because it is derived data.

Tables:

- `chat_meta`
- `local_conversations`
- `local_conversation_states`
- `local_messages`
- `local_read_receipts`
- `outbox_messages`
- `outbox_attachments`
- `sync_journal`

Indexes must support auth isolation, conversation message ordering by `message_seq`, outbox scanning by state, and cursor lookup.

### ChatSyncService

One service owns all chat synchronization.

Inputs:

- app startup
- app foreground
- reconnect
- push received
- notification tap
- realtime hint
- pull-to-refresh
- outbox state change

Responsibilities:

- Serialize sync jobs by scope.
- Coalesce duplicate triggers.
- Fetch bootstrap/sync/history data.
- Apply sync events transactionally.
- Advance cursor in the same transaction as row changes.
- Run outbox pump and reconcile uncertain sends.
- Invalidate auth-scoped React Query selectors after committed writes.
- Write `sync_journal` diagnostics.

Screens must not subscribe to PocketBase chat collections directly and must not merge realtime records into UI state.

### React Query

Every chat query key includes `authId`.

Examples:

- `['chat', authId, 'conversations']`
- `['chat', authId, 'messages', conversationId]`
- `['chat', authId, 'conversation-state', conversationId]`
- `['chat', authId, 'outbox', conversationId]`

Query functions read SQLite selectors only. Network refresh is triggered by `ChatSyncService`, not by query functions silently falling back to server APIs.

### Durable Outbox

Text and attachment sends are first persisted locally with `client_message_id`.

Message states:

- `queued`
- `preflight`
- `uploading_attachments`
- `ready_to_create`
- `sending_create`
- `reconciling`
- `confirmed`
- `retry_wait`
- `failed_terminal`
- `cancel_requested`
- `canceled`
- `orphaned_needs_user`

Attachment states:

- `local_copying`
- `local_ready`
- `upload_queued`
- `uploading`
- `uploaded`
- `upload_retry_wait`
- `upload_failed_terminal`
- `delete_pending`

Attachment files must be copied to app-owned durable storage before enqueueing. Picker/cache URIs are metadata only and cannot be required for retry.

### Rendering

The message selector merges server messages and local outbox rows by `client_message_id`.

- Confirmed server rows replace local pending rows.
- Pending rows sort by local creation time until server `message_seq` exists.
- Duplicate delivery through push, realtime, manual sync, and retry must produce one bubble.
- Large histories require virtualized rendering and paginated history sync.

## Migration Plan

Breaking changes are allowed, but server data must not be lost.

1. Add server fields and new collections additively.
2. Gate old clients or enter maintenance mode before incompatible writes.
3. Backfill historical `message_seq` per conversation using `(created ASC, id ASC)`.
4. Backfill `conversation_user_states` from `conversation_reads.last_read_at`.
5. Recompute conversation previews from highest non-deleted `message_seq`.
6. Preserve existing message IDs and PocketBase attachment files.
7. Add new client SQLite schema version or DB name and wipe old derived cache.
8. First new-client launch runs `/bootstrap` and stores current cursor.
9. Old clients must receive upgrade-required for incompatible write paths.

## Testing Requirements

The architecture is not complete until it is testable.

Required test layers:

- TypeScript unit tests for sync reducers/selectors/outbox transitions.
- SQLite transaction tests for event apply and cursor advancement.
- Go backend tests for command endpoints, idempotency, sequence assignment, and read monotonicity.
- Integration tests against real PocketBase and SQLite.
- Deterministic simulator for network loss, app kill, push/realtime duplicates, and cursor catch-up.

Must-cover scenarios:

- foreground receive
- background push then open
- killed app notification tap
- offline send then restart
- request success with lost response
- push and realtime duplicate hint
- concurrent sends
- delete/edit while client offline
- multi-device read advancement
- auth switch
- attachment upload interruption
- cursor too old requiring full resync

## Observability

Add local `sync_journal` and debug UI fields:

- DB schema version
- auth/device hash
- global cursor
- per-conversation cursor
- last sync trigger/result/error
- outbox counts and oldest age
- last realtime hint
- last push hint
- detected sequence gaps
- force full resync action
- redacted journal export

Server logs/metrics:

- message command accepted
- idempotency hit/conflict
- sequence assigned
- sync rows returned
- push outbox sent/failed
- APNs rejection reason
- preview mismatch detector
- unread drift detector

## Implementation Order

1. Backend schema and protocol endpoints.
2. Backend backfill/version gate/push outbox.
3. Mobile SQLite v3 store and selectors.
4. `ChatSyncService` single sync queue.
5. Durable text outbox.
6. Move UI to SQLite selectors and remove screen-level sync.
7. Sequence-based read/unread.
8. Durable attachment outbox.
9. Virtualized message rendering.
10. Remove old timestamp sync and direct realtime merge paths.
