# Chat Media Architecture

This document records the agreed target architecture for InfChat media, file, video, and future attachment-backed messages. It is a product and engineering specification, not a staged MVP plan. The goal is to build the final Telegram-like media system directly, without temporary simplified paths that would need to be replaced later.

## Goals

- Support Telegram-like media albums where one message can contain multiple photos and videos mixed together.
- Support image, video, file, and voice messages through one durable attachment pipeline.
- Support picking photos/videos from the system library and capturing photos/videos directly in-app.
- Support native system document preview from the first implementation: Quick Look on iOS and Android file intents.
- Support local thumbnail, preview, original media, file, and voice cache management from the first implementation.
- Support resumable direct uploads to S3-compatible object storage without exposing long-lived storage credentials to clients.
- Keep the storage provider replaceable: moving buckets to another S3-compatible provider must only require copying objects and changing server configuration.
- Keep chat correctness tied to the existing sync model: server-assigned message sequence, durable events, idempotency, SQLite replica, and local outbox.

## Non-Goals

- Do not send media through PocketBase as a server-side file proxy.
- Do not use PocketBase collection CRUD directly for media messages.
- Do not expose S3 access keys or secret keys to mobile clients.
- Do not depend on provider-specific S3 features such as ACLs, bucket policies, versioning, object lock, tagging, KMS, notification hooks, replication, or lifecycle beyond optional operational cleanup.
- Do not treat video as a generic file if it is intended to render as media in chat.
- Do not implement a temporary `image`-only or `file`-only message path separate from the final attachment architecture.

## Current Context

The current chat sync refactor intentionally narrowed the active send path to text messages. The backend schema still has concepts for `image`, `file`, `voice`, and `call`, and the mobile chat screen still contains old image/file rendering code, but the command endpoint rejects non-text messages.

The narrowed text-only path was a correctness decision. The old attachment implementation used raw `messages` collection creates, which bypasses the new protocol requirements: durable local outbox, idempotency, server-assigned `message_seq`, `conversation_events`, read correctness, local SQLite convergence, and retry recovery. Media support must be reintroduced through the command/sync architecture, not by reopening raw CRUD.

## Message Model

Use a normalized message and attachment model instead of relying on `messages.attachments` as an array of file names.

`messages.kind` should represent the bubble-level rendering family:

- `text`: text-only message.
- `media`: photo/video album message. A single `media` message can contain images and videos mixed together.
- `file`: document/file message. The default product rule is one logical file message per file unless a later explicit product decision chooses grouped documents.
- `voice`: voice message.
- `call`: call event message.

`message_attachments.kind` should represent each attachment's concrete media type:

- `image`
- `video`
- `file`
- `voice`

### Messages Collection

`messages` must keep the sync-critical fields:

- `conversation`: conversation relation.
- `sender`: user relation.
- `sender_membership`: membership relation at send time.
- `kind`: `text`, `media`, `file`, `voice`, or `call`.
- `body`: text body or caption.
- `message_seq`: monotonic per-conversation server sequence.
- `client_message_id`: durable client idempotency key.
- `sender_device_id`: sending device identity.
- `call_room`: call message relation or identifier when applicable.
- `deleted_at`: soft-delete marker.
- `deleted_by`: deleter relation.
- `edited_at`: edit display timestamp.
- `edit_version`: monotonic edit version.
- `created`, `updated`.

### Message Attachments Collection

Create `message_attachments` as the canonical attachment metadata table.

Fields:

- `id`: stable attachment id.
- `message`: message relation.
- `conversation`: denormalized conversation relation for filtering and cleanup.
- `sender`: denormalized sender relation for auditing and cleanup.
- `ordinal`: attachment order inside the message.
- `kind`: `image`, `video`, `file`, or `voice`.
- `original_name`: original user-visible file name.
- `mime_type`: canonical MIME type.
- `byte_size`: original byte size.
- `width`: image/video width when available.
- `height`: image/video height when available.
- `duration_ms`: video/voice duration when available.
- `sha256`: content hash for integrity and idempotency.
- `blurhash`: optional low-quality placeholder for images/video posters.
- `processing_status`: `pending`, `ready`, `failed`, or equivalent.
- `created`, `updated`.

Variant fields should either be stored as explicit columns or a normalized `attachment_variants` table. Prefer a normalized table if more than the initial variants are expected.

Required variants:

- `thumbnail`: small image thumbnail or video poster for chat list/grid display.
- `preview`: medium image preview for in-chat display and fast full-screen first paint.
- `original`: original image, original video, original document, or original voice audio.
- `poster`: canonical video still frame if kept separate from `thumbnail`.

Each variant records:

- `attachment_id`
- `variant`
- `storage_profile_id`
- `object_key`
- `mime_type`
- `byte_size`
- `width`
- `height`
- `duration_ms`
- `sha256`

## Product Semantics

### Media Albums

One user send action from the media picker can produce one `media` message containing multiple attachments.

Rules:

- A single `media` message can contain images and videos mixed together.
- Attachment order is the selection/capture order and is stored in `ordinal`.
- A caption is stored in `messages.body` and applies to the album.
- The chat bubble renders a Telegram-like album grid.
- Video cells show poster, play icon, and duration.
- Image cells show thumbnail/preview.
- Tapping any media item opens a full-screen gallery starting at that item.
- The full-screen gallery can swipe across all attachments in the same message.
- Video playback in the full-screen gallery uses the video viewer, not document preview.

Album layout target:

- 1 item: single adaptive media tile.
- 2 items: two-column layout.
- 3 items: one large tile plus two smaller tiles, or equivalent Telegram-like composition.
- 4 items: 2x2 grid.
- 5 or more: grid with overflow indicator if needed by the final layout.

### Files

File messages use `messages.kind = 'file'` and one `message_attachments.kind = 'file'` attachment.

Rules:

- Files are not downloaded by default.
- The bubble shows file icon, display name, size, download/open state, and timestamp.
- Tapping downloads the file if missing from local cache.
- After download, opening uses native preview/open behavior.
- Downloaded files are indexed in the cache manager and can be cleared from storage settings.
- If the platform cannot preview a file, it should present the platform open-in/chooser behavior rather than a custom dead end.

### Voice

Voice messages use `messages.kind = 'voice'` and one `message_attachments.kind = 'voice'` attachment.

Voice metadata must include:

- `duration_ms`
- `mime_type`
- codec/container when available.
- `byte_size`
- optional waveform samples.
- optional transcription fields if introduced later.

Rules:

- Recording output is copied to durable outbox storage before enqueueing.
- Pending voice bubbles play local durable files before upload confirmation.
- Only one voice message should play at a time.
- Playback must handle interruption, route changes, and background/foreground transitions consistently with the app's call/audio behavior.

### Video

Video is media, not a generic file, when selected or captured as part of a media send.

Video metadata must include:

- `duration_ms`
- `width`
- `height`
- `mime_type`
- `byte_size`
- canonical poster/thumbnail variant.

Rules:

- Chat list/grid loads only poster/thumbnail by default.
- Original video is fetched only when the user opens or plays the video, unless a future auto-download setting explicitly allows otherwise.
- Video playback uses `expo-video`.
- Video cache uses the same InfChat media cache index. If `expo-video` internal cache is enabled, it must be reconciled with storage settings or avoided for files that must be user-clearable through InfChat settings.

## Backend Protocol

All message creation remains command-based. The client must not create `messages` or `message_attachments` directly through raw collection CRUD.

Required command groups:

- Media upload session endpoints.
- Message finalize/send endpoint.
- Media URL signing endpoint for downloads.
- Media processing/variant status endpoint if asynchronous processing is used.

### Upload Session Endpoints

The backend owns S3-compatible credentials and controls all object keys.

Endpoints:

- `POST /api/infchat/media/uploads/start`
- `POST /api/infchat/media/uploads/:id/sign-parts`
- `GET /api/infchat/media/uploads/:id/parts`
- `GET /api/infchat/media/uploads/:id/status`
- `POST /api/infchat/media/uploads/:id/complete`
- `POST /api/infchat/media/uploads/:id/abort`

Responsibilities:

- Authenticate the user.
- Verify active conversation membership.
- Validate attachment count, kind, MIME type, size, and quota.
- Allocate stable `upload_session_id`, `attachment_id`, and object keys.
- Initiate multipart upload for large objects.
- Generate short-lived presigned URLs for PUT part uploads.
- Refresh expired part URLs without changing upload identity.
- List uploaded parts when provider support is available.
- Complete multipart uploads after the client reports all part ETags.
- Abort uploads on user cancellation or server cleanup.
- Record enough state for app restart and lost-response recovery.

### Message Finalize Endpoint

The final message command creates the authoritative chat record after all required original and generated variants are uploaded or accepted for processing.

`POST /api/infchat/messages/send` must atomically:

1. Authenticate and authorize active membership.
2. Normalize message kind and body/caption.
3. Validate upload sessions and attachment ownership.
4. Verify all required objects exist in object storage with expected sizes.
5. Check idempotency by `(user, device_id, client_message_id)`.
6. Include attachment ids, object keys, hashes, MIME types, sizes, dimensions, durations, and order in the idempotency payload hash.
7. Assign `message_seq` from `conversations.next_message_seq`.
8. Create `messages` row.
9. Create `message_attachments` and variant rows.
10. Update conversation preview.
11. Create `conversation_events` payload containing message and attachment metadata, not large binary data.
12. Persist idempotency result cursor.
13. Commit before sending push notifications.

If a request is retried with the same idempotency key and identical payload, return the original result. If any attachment list, order, hash, kind, body, or object key differs, return a conflict.

### Download URL Endpoint

Clients should not persist long-lived media URLs. They request URLs when needed.

Endpoint:

- `POST /api/infchat/media/urls`

Behavior:

- Accepts attachment variant ids or attachment ids plus requested variants.
- Verifies the requesting user is allowed to view the conversation and message history.
- Returns short-lived signed GET URLs or CDN signed URLs.
- Supports batching thumbnails/posters for visible messages.
- Supports separate TTLs for thumbnails, previews, originals, and documents.

## Object Storage

Use S3-compatible object storage with direct client-to-bucket upload and download. There is no PocketBase file-content proxy in the target design.

### Credential Model

- Long-lived S3 credentials live only on the backend.
- Mobile clients never receive long-lived access keys or secret keys.
- Mobile clients do not receive broad temporary STS credentials in the default design.
- Mobile clients receive only short-lived presigned URLs scoped to a single object key, HTTP method, and part number where applicable.

### Provider Requirements

Depend only on common S3-compatible operations:

- `PutObject`
- `GetObject`
- `HeadObject`
- `DeleteObject`
- `CreateMultipartUpload`
- `UploadPart`
- `CompleteMultipartUpload`
- `AbortMultipartUpload`

Preferred but optional:

- `ListParts`
- `ListMultipartUploads`
- `Range` support for `GetObject`

Do not require:

- ACLs
- bucket policies
- bucket versioning
- object lock
- object tagging
- bucket notifications
- replication
- KMS-specific headers
- provider-specific lifecycle features

### Storage Profiles

The backend should use a provider-neutral storage profile configuration.

Fields:

- `id`
- `driver`: initially `s3`.
- `endpoint`
- `region`
- `bucket`
- `public_base_url`
- `force_path_style`
- `presign_ttl_seconds`
- `multipart_threshold_bytes`
- `multipart_part_size_bytes`
- `max_object_size_bytes`
- `capabilities_json`

Secrets such as access keys should come from environment variables or a secret manager. Admin UI configuration can expose non-secret fields, but must not display or store raw long-lived secrets in ordinary application records unless encrypted secret storage is implemented.

### Object Key Format

Object keys must not encode the storage provider or endpoint. They must remain valid when the bucket is copied to a new provider.

Recommended pattern:

```txt
media/{tenantId}/{conversationId}/{yyyy}/{mm}/{messageId}/{attachmentId}/original
media/{tenantId}/{conversationId}/{yyyy}/{mm}/{messageId}/{attachmentId}/thumb_320
media/{tenantId}/{conversationId}/{yyyy}/{mm}/{messageId}/{attachmentId}/preview_1280
media/{tenantId}/{conversationId}/{yyyy}/{mm}/{messageId}/{attachmentId}/poster
```

Migration to another provider:

1. Copy the bucket contents to the new provider preserving object keys.
2. Update the active storage profile endpoint, region, bucket, and path-style setting.
3. Existing database rows keep the same `object_key` values.
4. Newly signed URLs point to the new provider automatically.

## Multipart Upload and Resume

Use direct presigned multipart upload for large files.

Server control plane:

- Creates multipart uploads.
- Signs individual part uploads.
- Completes multipart uploads.
- Aborts incomplete uploads.
- Lists parts if the provider supports it.

Client data plane:

- Reads byte ranges from local durable files.
- Uploads each part directly to the signed S3-compatible URL.
- Stores returned `ETag` per part.
- Persists progress in SQLite.
- Resumes missing parts after app restart, network loss, or URL expiration.

Upload session state must include:

- `upload_session_id`
- `attachment_id`
- `conversation_id`
- `client_message_id`
- `object_key`
- `upload_id`
- `file_uri`
- `file_size`
- `file_sha256`
- `mime_type`
- `part_size`
- `state`
- `expires_at`
- per-part `part_number`, `offset`, `length`, `etag`, `state`, `attempt_count`, `last_error`.

Resume flow:

1. On startup, scan SQLite for incomplete upload sessions.
2. Ask the backend for upload session status.
3. If provider `ListParts` is supported, reconcile local part state with provider part state.
4. Refresh signed URLs for missing or expired parts.
5. Upload only missing or failed parts.
6. Complete after all required ETags are present.

Important constraints:

- S3 multipart part numbers must be stable.
- The client must record ETags returned by successful part uploads.
- S3 multipart ETag is not a reliable full-file hash.
- Full-file integrity must use the recorded `sha256`.
- Failed retries to the same part number may require re-uploading that part.
- Incomplete multipart uploads must be aborted by explicit cleanup jobs to avoid storage leaks.

## Client Upload Engine

There is no fully suitable off-the-shelf React Native/Expo library that satisfies all requirements: S3-compatible presigned multipart upload, no client storage credentials, durable app-restart resume, native file URI handling, and mobile background resilience.

Use a dedicated InfChat upload engine.

### Service Layer

The TypeScript service owns:

- Upload session creation.
- SQLite upload state.
- Retry scheduling.
- URL refresh.
- Interaction with `ChatSyncService` outbox.
- Progress events for UI.
- Completion and final message send.
- Cancellation and abort.

### Native Transfer Layer

Implement a local Expo Module for efficient byte-range upload using platform-native networking.

iOS:

- Use `URLSession`.
- Read file byte ranges from durable local files.
- Support progress, cancel, retry, and background-friendly behavior where feasible.

Android:

- Use `OkHttp` for HTTP PUT part uploads.
- Use `WorkManager` for resilient background/retry behavior where appropriate.
- Read byte ranges without moving large chunks through JS memory.

TypeScript API shape:

```ts
uploadPart({
  fileUri,
  offset,
  length,
  url,
  headers,
  partNumber,
  uploadSessionId,
})
```

The native module is not an S3 SDK and does not know storage credentials. It uploads a local byte range to a presigned URL and reports progress plus response headers.

## Libraries and Platform APIs

Use the following libraries and APIs:

- `expo-image-picker`: system photo/video library selection. Use `allowsMultipleSelection`, `selectionLimit`, `orderedSelection`, and media types for images and videos.
- `expo-camera`: Telegram-like in-app camera for direct photo and video capture.
- `expo-video`: video playback and full-screen media viewer playback.
- `expo-media-library`: saving downloaded or captured media to the user's library when the user explicitly requests it.
- `expo-document-picker`: system file picking.
- `expo-file-system`: durable local file copies, cache files, storage accounting, and content URI support.
- `expo-image`: preferred image rendering and image cache behavior where it gives better cache control than React Native `Image`.
- `expo-intent-launcher`: Android document open intents when needed by the native preview module.
- Local Expo Module `InfchatDocumentPreview`: iOS Quick Look and Android open-with/intent abstraction.
- Local Expo Module `InfchatMediaTools`: media metadata, thumbnail/poster generation, file hashing, and efficient upload byte-range support if kept together with the transfer module.

Avoid as primary solutions:

- `expo-sharing` as the main file preview path. It may remain a fallback, but native preview/open behavior is required.
- `expo-video-thumbnails` as the long-term thumbnail generator because Expo documentation marks it deprecated in favor of newer video APIs. Prefer native media tooling through the local module or canonical server-generated variants.
- `@aws-sdk/lib-storage` on the mobile client as the primary uploader because it expects client credentials and does not solve durable app-restart resume for the no-client-secret presigned URL model.
- `@uppy/aws-s3` on mobile as the primary uploader. Its API design is a useful reference and it can be used later for a web client, but it is not the native Expo mobile transfer layer.
- `tus-js-client` unless a tus server is introduced. The target storage path is direct S3-compatible upload, not a tus server pipeline.

## Capture and Picker UX

System picker:

- Supports images and videos.
- Supports multi-select.
- Preserves selected order where the platform supports ordered selection.
- Copies every selected asset to app-owned durable outbox storage before enqueueing.
- Computes metadata before upload starts.

In-app camera:

- Uses `expo-camera` rather than only the system camera sheet.
- Supports taking photos and recording videos.
- Produces the same attachment input format as the picker.
- Saves a durable local copy before enqueueing.
- Can optionally allow review, retake, caption, and album composition before send.

Document picker:

- Uses `expo-document-picker`.
- Copies picked documents to app-owned durable outbox storage.
- Stores original name, MIME type, byte size, and hash.

## Media Processing

Client-generated metadata is required for immediate pending UI. Server-generated metadata/variants are canonical after sync.

Client should generate:

- Image width and height.
- Video width, height, and duration.
- Video poster for pending UI.
- File size and MIME type.
- SHA-256 hash.

Server should verify and/or generate:

- Canonical thumbnails.
- Canonical previews.
- Canonical video posters.
- Validated dimensions and durations.
- Optional blurhash.

The conversation event payload should include metadata and variant references, not embedded binary thumbnails or large base64 data.

## Local Cache

Implement a first-class cache index. Do not rely only on opaque library caches for media the user expects to manage in InfChat settings.

Cache variants:

- `thumbnail`: auto-fetched for visible image/video cells.
- `poster`: auto-fetched for visible video cells when separate from thumbnail.
- `preview`: fetched for better in-chat display or first full-screen paint according to network/cache policy.
- `original`: fetched when the user opens full-resolution image/video or explicitly saves/shares.
- `file`: fetched when the user opens/downloads a document.
- `voice`: fetched when needed for playback according to voice preload policy.

`media_cache_entries` fields:

- `cache_key`
- `auth_id`
- `conversation_id`
- `message_id`
- `attachment_id`
- `variant`
- `local_uri`
- `remote_object_key`
- `mime_type`
- `byte_size`
- `sha256`
- `width`
- `height`
- `duration_ms`
- `state`
- `last_accessed_at`
- `created_at`
- `pinned`
- `protected_reason`

Cache rules:

- Thumbnails and posters may be fetched automatically.
- Originals are not fetched until the user opens or explicitly downloads them unless a future auto-download setting is introduced.
- Files are never downloaded by default.
- Outbox source files are not cache entries and must not be deleted by cache cleanup while the message is unconfirmed.
- Active preview/playback files must not be deleted while in use.
- Cache cleanup must be LRU-aware.
- Cache entries must be scoped by auth user to avoid cross-account leakage on shared devices.

Storage settings must support:

- Total cache usage.
- Usage by type: images, videos, files, voice.
- Usage by conversation.
- Clear all non-protected cache.
- Clear one conversation's cache.
- Clear by type.
- Preserve pending outbox files.
- Preserve pinned or actively used items.

## Download and Preview

### Images

- Chat grid loads thumbnail/preview only.
- Full-screen viewer requests original only when opened.
- Original is stored in the managed media cache.
- Viewer prefers local cache over signed URL.

### Videos

- Chat grid loads poster/thumbnail only.
- Full-screen viewer requests original video URL or local cached original.
- Playback uses `expo-video`.
- Range-capable signed GET URLs are required for streaming and seeking.
- If full original is downloaded, it is stored in managed media cache.

### Files

- File bubble does not fetch the file body until user action.
- User action requests a signed URL, downloads the file into managed cache, then opens it.
- iOS uses Quick Look through `InfchatDocumentPreview`.
- Android uses ACTION_VIEW/open-with through `InfchatDocumentPreview` and content URIs.
- If native preview is unavailable, fall back to platform open-in/share behavior.

### Signed URL TTL

- Signed URLs are short-lived and must not be treated as persistent state.
- The cache stores local files, not remote URLs.
- URL expiration should only trigger URL refresh, not message state changes.

## Native Document Preview

Create local Expo Module `InfchatDocumentPreview`.

TypeScript API:

```ts
openDocument({
  localUri,
  fileName,
  mimeType,
  title,
})
```

iOS behavior:

- Use `QLPreviewController`.
- Use `QLPreviewController.canPreview` when applicable.
- Retain the preview item/local URL for the preview lifecycle.
- If Quick Look cannot preview, present document interaction/open-in behavior.

Android behavior:

- Convert app file URI to content URI.
- Launch ACTION_VIEW with MIME type and read permission.
- Use chooser/open-with when appropriate.
- Handle no-activity-found errors with a user-facing message.

The JS layer should not branch on detailed platform preview behavior. It calls the module with a local file and receives success/cancel/error.

## Chat UI Requirements

Message selectors must merge:

- Server messages.
- Server attachments.
- Local outbox messages.
- Local outbox attachments.
- Cache state.
- Upload/download progress.

Rendering requirements:

- Pending media albums render immediately from durable local files.
- Confirmed server messages replace pending bubbles by `client_message_id`.
- Upload progress is shown per message and optionally per attachment.
- Failed media sends can be retried without rebuilding the message.
- User cancellation aborts uploads and removes outbox state.
- Duplicate sync/push/retry paths must not duplicate bubbles.
- Virtualized list item heights should be stable using stored metadata.
- Media grids should use dimensions/duration metadata instead of waiting for remote image probing.

## Privacy and App Permissions

The app's privacy policy and store disclosures must be updated when media features ship.

Permissions and disclosures must cover:

- Photo library access for selecting images/videos.
- Camera access for taking photos and recording videos.
- Microphone access for video capture and voice messages.
- Local file/document access through system picker.
- Local caching of downloaded media and files.
- Optional saving media to the user's library when explicitly requested.

The current privacy policy text that says the app only sends text messages and does not request photo library/microphone for messaging will become incorrect and must be revised before release.

## Operational Cleanup

The backend must clean up incomplete media state.

Cleanup jobs:

- Abort stale multipart uploads.
- Delete unreferenced objects for failed or abandoned upload sessions.
- Delete old upload session rows after safe retention.
- Detect attachment records whose objects are missing.
- Detect objects whose database records are missing where provider listing is available.

Object storage lifecycle rules for aborting incomplete multipart uploads may be enabled when the provider supports them, but the app must not rely on provider lifecycle as the only cleanup mechanism.

## Provider Portability

Provider portability is a hard requirement.

Rules:

- Store object keys, not permanent provider URLs.
- Generate URLs at request time from the active storage profile.
- Keep provider-specific behavior behind a backend storage adapter.
- Avoid storing S3 ETag as the only integrity marker.
- Use app-level SHA-256 for content identity.
- Keep storage profile id on object records so migrations can be audited.
- Preserve object keys when copying buckets between providers.

## Testing Requirements

Backend tests:

- Upload session start authorization.
- MIME, size, count, and quota validation.
- Multipart create/sign/complete/abort behavior against an S3-compatible test service.
- Idempotent message finalize with identical payload.
- Conflict on same `client_message_id` with different attachment payload.
- Signed URL access authorization.
- Storage profile path-style and endpoint compatibility.

Mobile tests:

- Picker multi-select with images and videos.
- Camera capture photo/video enqueue.
- Durable outbox survives app restart.
- Multipart upload resumes missing parts only.
- URL expiration refreshes without losing progress.
- Pending media bubble becomes confirmed bubble without duplication.
- Cache index records thumbnail, preview, original, file, and voice variants.
- Cache cleanup preserves outbox and active preview files.
- iOS Quick Look opens supported files.
- Android intent opens supported files and handles unsupported files.

Failure scenarios:

- Network loss during part upload.
- App killed after some parts uploaded.
- Server response lost after complete.
- Signed URL expires mid-upload.
- Provider `ListParts` unavailable or inconsistent.
- Object exists but DB finalize fails.
- DB finalize succeeds but push/sync delivery is delayed.
- User switches auth accounts on same device.

## Design Decisions From Discussion

- Build the final Telegram-like architecture directly; do not ship a temporary simplified media path.
- A single media message can mix images and videos.
- Video sending, video thumbnails/posters, duration, dimensions, and playback are part of the initial target design.
- Direct in-app photo/video capture is part of the target design.
- Files require native system preview from the initial implementation: Quick Look on iOS and Android intents/open-with.
- Media cache and cache management are part of the core data model, not a later settings add-on.
- Direct S3-compatible bucket upload/download is the target transport.
- PocketBase does not proxy file bytes in the target design.
- Backend signs and controls uploads; clients do not hold long-lived S3 credentials.
- A dedicated InfChat mobile upload engine is required because no existing Expo/RN library fully satisfies the target requirements.
- The Uppy S3 API shape is a good reference for backend endpoint design, and Uppy may be useful for a future web client, but it is not the mobile upload implementation.
