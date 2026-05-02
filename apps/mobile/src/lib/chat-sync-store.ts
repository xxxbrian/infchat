import {
  type ConversationEventPayload,
  type ConversationEventRecord,
  type ConversationMembershipRecord,
  type ConversationRecord,
  type AttachmentVariantRecord,
  type MessageAttachmentRecord,
  type MessageRecord,
} from '@infchat/pocketbase';
import * as SQLite from 'expo-sqlite';

import { logDebugEvent } from './debug-log';

type JsonRow = {
  value: string;
};

type CursorRow = {
  cursor: number;
};

type TableInfoRow = {
  name: string;
};

export type OutboxMessageState =
  | 'queued'
  | 'sending_create'
  | 'confirmed'
  | 'retry_wait'
  | 'failed_terminal'
  | 'canceled';

export type LocalOutboxMessage = {
  attempt_count?: number | null;
  auth_id: string;
  body: string;
  client_created_at: string;
  client_message_id: string;
  conversation_id: string;
  last_error?: string | null;
  next_attempt_at?: string | null;
  server_message_id?: string | null;
  state: OutboxMessageState;
  updated_at: string;
};

export type LocalMediaAttachmentKind = 'image' | 'video' | 'file' | 'voice';
export type LocalMediaMessageKind = Extract<MessageRecord['kind'], 'media' | 'file' | 'voice'>;
export type LocalMediaVariant = 'thumbnail' | 'preview' | 'original' | 'poster';

export type LocalMediaOutboxState =
  | 'queued'
  | 'starting_uploads'
  | 'uploading'
  | 'ready_to_send'
  | 'sending_create'
  | 'confirmed'
  | 'retry_wait'
  | 'failed_terminal'
  | 'canceled';

export type LocalMediaAttachmentState =
  | 'queued'
  | 'session_started'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'canceled';

export type LocalMediaUploadSessionState =
  | 'pending'
  | 'session_started'
  | 'uploading'
  | 'uploaded'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'expired';

export type LocalMediaUploadPartState = 'pending' | 'signed' | 'uploading' | 'uploaded' | 'failed';
export type LocalMediaCacheEntryState = 'available' | 'downloading' | 'failed' | 'evicted';

export type LocalMediaOutboxMessage = {
  attempt_count?: number | null;
  auth_id: string;
  body: string;
  client_created_at: string;
  client_message_id: string;
  conversation_id: string;
  kind: LocalMediaMessageKind;
  last_error?: string | null;
  next_attempt_at?: string | null;
  server_message_id?: string | null;
  state: LocalMediaOutboxState;
  updated_at: string;
};

export type LocalMediaOutboxAttachment = {
  auth_id: string;
  blurhash?: string | null;
  byte_size: number;
  client_attachment_id: string;
  client_message_id: string;
  conversation_id: string;
  duration_ms?: number | null;
  height?: number | null;
  kind: LocalMediaAttachmentKind;
  local_uri: string;
  mime_type: string;
  ordinal: number;
  original_name: string;
  poster_local_uri?: string | null;
  sha256?: string | null;
  state: LocalMediaAttachmentState;
  thumbnail_local_uri?: string | null;
  updated_at: string;
  width?: number | null;
};

export type LocalMediaOutboxMessageWithAttachments = LocalMediaOutboxMessage & {
  attachments: LocalMediaOutboxAttachment[];
};

export type EnqueueMediaOutboxAttachmentInput = {
  blurhash?: string | null;
  byteSize: number;
  clientAttachmentId?: string;
  durationMs?: number | null;
  height?: number | null;
  kind: LocalMediaAttachmentKind;
  localUri: string;
  mimeType: string;
  ordinal?: number;
  originalName: string;
  posterLocalUri?: string | null;
  sha256?: string | null;
  thumbnailLocalUri?: string | null;
  width?: number | null;
};

export type EnqueueMediaOutboxMessageInput = {
  attachments: EnqueueMediaOutboxAttachmentInput[];
  body?: string;
  clientMessageId?: string;
  conversationId: string;
  kind: LocalMediaMessageKind;
};

export type LocalMediaUploadSession = {
  attachment_id?: string | null;
  attachment_kind: LocalMediaAttachmentKind;
  auth_id: string;
  blurhash?: string | null;
  byte_size: number;
  client_attachment_id: string;
  client_message_id: string;
  completed_at?: string | null;
  conversation_id: string;
  duration_ms?: number | null;
  expires_at?: string | null;
  height?: number | null;
  last_error?: string | null;
  local_uri: string;
  mime_type: string;
  object_key?: string | null;
  original_name: string;
  part_count?: number | null;
  part_size?: number | null;
  presigned_expires_at?: string | null;
  presigned_headers_json?: string | null;
  presigned_method?: string | null;
  presigned_url?: string | null;
  profile_json?: string | null;
  sha256?: string | null;
  state: LocalMediaUploadSessionState;
  storage_profile_id?: string | null;
  updated_at: string;
  upload_id?: string | null;
  upload_mode?: 'single' | 'multipart' | null;
  upload_session_id?: string | null;
  variant: LocalMediaVariant;
  width?: number | null;
};

export type CompletedMediaUploadSession = LocalMediaUploadSession & {
  upload_session_id: string;
};

export type UpsertMediaUploadSessionInput = {
  attachmentId?: string | null;
  attachmentKind: LocalMediaAttachmentKind;
  blurhash?: string | null;
  byteSize: number;
  clientAttachmentId: string;
  clientMessageId: string;
  completedAt?: string | null;
  conversationId: string;
  durationMs?: number | null;
  expiresAt?: string | null;
  height?: number | null;
  lastError?: string | null;
  localUri: string;
  mimeType: string;
  objectKey?: string | null;
  originalName: string;
  partCount?: number | null;
  partSize?: number | null;
  presignedExpiresAt?: string | null;
  presignedHeadersJson?: string | null;
  presignedMethod?: string | null;
  presignedUrl?: string | null;
  profileJson?: string | null;
  sha256?: string | null;
  state?: LocalMediaUploadSessionState;
  storageProfileId?: string | null;
  uploadId?: string | null;
  uploadMode?: 'single' | 'multipart' | null;
  uploadSessionId?: string | null;
  variant: LocalMediaVariant;
  width?: number | null;
};

export type LocalMediaUploadPart = {
  attempt_count?: number | null;
  auth_id: string;
  byte_size: number;
  client_attachment_id: string;
  client_message_id: string;
  etag?: string | null;
  last_error?: string | null;
  offset_bytes: number;
  part_number: number;
  signed_url?: string | null;
  signed_url_expires_at?: string | null;
  signed_url_headers_json?: string | null;
  signed_url_method?: string | null;
  state: LocalMediaUploadPartState;
  updated_at: string;
  upload_session_id?: string | null;
  variant: LocalMediaVariant;
};

export type UpsertMediaUploadPartInput = {
  attemptCount?: number | null;
  byteSize: number;
  clientAttachmentId: string;
  clientMessageId: string;
  etag?: string | null;
  lastError?: string | null;
  offsetBytes: number;
  partNumber: number;
  signedUrl?: string | null;
  signedUrlExpiresAt?: string | null;
  signedUrlHeadersJson?: string | null;
  signedUrlMethod?: string | null;
  state?: LocalMediaUploadPartState;
  uploadSessionId?: string | null;
  variant: LocalMediaVariant;
};

export type LocalMediaCacheEntry = {
  attachment_id: string;
  auth_id: string;
  byte_size?: number | null;
  cache_key: string;
  conversation_id: string;
  created_at: string;
  duration_ms?: number | null;
  height?: number | null;
  last_accessed_at: string;
  local_uri: string;
  message_id: string;
  mime_type?: string | null;
  pinned: number;
  protected_reason?: string | null;
  remote_object_key: string;
  sha256?: string | null;
  state: LocalMediaCacheEntryState;
  variant: LocalMediaVariant | 'file' | 'voice';
  width?: number | null;
};

export type UpsertMediaCacheEntryInput = {
  attachmentId: string;
  byteSize?: number | null;
  cacheKey: string;
  conversationId: string;
  durationMs?: number | null;
  height?: number | null;
  localUri: string;
  messageId: string;
  mimeType?: string | null;
  pinned?: boolean;
  protectedReason?: string | null;
  remoteObjectKey: string;
  sha256?: string | null;
  state?: LocalMediaCacheEntryState;
  variant: LocalMediaVariant | 'file' | 'voice';
  width?: number | null;
};

const CHAT_SYNC_SCHEMA_VERSION = 5;
const dbPromise = SQLite.openDatabaseAsync('infchat-chat-sync-v4.db');
let schemaPromise: Promise<void> | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

type SqliteWriter = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

function enqueueDbWrite<T>(task: () => Promise<T>): Promise<T> {
  const write = writeQueue.then(task, task);
  writeQueue = write.catch(() => {});

  return write;
}

async function getDb() {
  const db = await dbPromise;

  schemaPromise ??= db
    .execAsync(
      `
    CREATE TABLE IF NOT EXISTS chat_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_conversations (
      auth_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      last_message_seq INTEGER NOT NULL DEFAULT 0,
      latest_event_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS local_conversations_sort_idx
      ON local_conversations (auth_id, last_message_seq DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS local_memberships (
      auth_id TEXT NOT NULL,
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      history_start_message_seq INTEGER NOT NULL DEFAULT 1,
      last_read_message_seq INTEGER NOT NULL DEFAULT 0,
      live_start_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS local_memberships_conversation_idx
      ON local_memberships (auth_id, conversation_id, status, user_id);

    CREATE INDEX IF NOT EXISTS local_memberships_user_idx
      ON local_memberships (auth_id, user_id, status);

    CREATE TABLE IF NOT EXISTS local_messages (
      auth_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      client_message_id TEXT,
      value TEXT NOT NULL,
      message_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS local_messages_conversation_seq_idx
      ON local_messages (auth_id, conversation_id, message_seq ASC, id ASC);

    CREATE INDEX IF NOT EXISTS local_messages_client_message_idx
      ON local_messages (auth_id, conversation_id, client_message_id);

    CREATE TABLE IF NOT EXISTS local_message_attachments (
      auth_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS local_message_attachments_message_idx
      ON local_message_attachments (auth_id, message_id, ordinal);

    CREATE INDEX IF NOT EXISTS local_message_attachments_conversation_idx
      ON local_message_attachments (auth_id, conversation_id, kind);

    CREATE TABLE IF NOT EXISTS local_attachment_variants (
      auth_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      variant TEXT NOT NULL,
      object_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS local_attachment_variants_attachment_idx
      ON local_attachment_variants (auth_id, attachment_id, variant);

    CREATE INDEX IF NOT EXISTS local_attachment_variants_message_idx
      ON local_attachment_variants (auth_id, message_id, variant);

    CREATE TABLE IF NOT EXISTS outbox_messages (
      auth_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      client_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      server_message_id TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      client_created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, client_message_id)
    );

    CREATE INDEX IF NOT EXISTS outbox_messages_state_idx
      ON outbox_messages (auth_id, state, next_attempt_at, client_created_at);

    CREATE TABLE IF NOT EXISTS media_outbox_messages (
      auth_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      client_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      server_message_id TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      client_created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, client_message_id)
    );

    CREATE INDEX IF NOT EXISTS media_outbox_messages_state_idx
      ON media_outbox_messages (auth_id, state, next_attempt_at, client_created_at);

    CREATE INDEX IF NOT EXISTS media_outbox_messages_conversation_idx
      ON media_outbox_messages (auth_id, conversation_id, state, client_created_at);

    CREATE TABLE IF NOT EXISTS media_outbox_attachments (
      auth_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      client_attachment_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      local_uri TEXT NOT NULL,
      thumbnail_local_uri TEXT,
      poster_local_uri TEXT,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      sha256 TEXT,
      blurhash TEXT,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, client_attachment_id)
    );

    CREATE INDEX IF NOT EXISTS media_outbox_attachments_message_idx
      ON media_outbox_attachments (auth_id, client_message_id, ordinal);

    CREATE INDEX IF NOT EXISTS media_outbox_attachments_conversation_idx
      ON media_outbox_attachments (auth_id, conversation_id, state);

    CREATE TABLE IF NOT EXISTS media_upload_sessions (
      auth_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      client_attachment_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      upload_session_id TEXT,
      attachment_id TEXT,
      conversation_id TEXT NOT NULL,
      attachment_kind TEXT NOT NULL,
      local_uri TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      sha256 TEXT,
      blurhash TEXT,
      storage_profile_id TEXT,
      profile_json TEXT,
      object_key TEXT,
      upload_id TEXT,
      upload_mode TEXT,
      part_size INTEGER,
      part_count INTEGER,
      presigned_url TEXT,
      presigned_method TEXT,
      presigned_headers_json TEXT,
      presigned_expires_at TEXT,
      state TEXT NOT NULL,
      expires_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, client_attachment_id, variant)
    );

    CREATE INDEX IF NOT EXISTS media_upload_sessions_state_idx
      ON media_upload_sessions (auth_id, state, updated_at);

    CREATE INDEX IF NOT EXISTS media_upload_sessions_remote_idx
      ON media_upload_sessions (auth_id, upload_session_id);

    CREATE INDEX IF NOT EXISTS media_upload_sessions_message_idx
      ON media_upload_sessions (auth_id, client_message_id, variant);

    CREATE TABLE IF NOT EXISTS media_upload_parts (
      auth_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      client_attachment_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      upload_session_id TEXT,
      offset_bytes INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      etag TEXT,
      signed_url TEXT,
      signed_url_method TEXT,
      signed_url_headers_json TEXT,
      signed_url_expires_at TEXT,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, client_attachment_id, variant, part_number)
    );

    CREATE INDEX IF NOT EXISTS media_upload_parts_state_idx
      ON media_upload_parts (auth_id, state, updated_at);

    CREATE INDEX IF NOT EXISTS media_upload_parts_session_idx
      ON media_upload_parts (auth_id, upload_session_id, part_number);

    CREATE TABLE IF NOT EXISTS media_cache_entries (
      auth_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      local_uri TEXT NOT NULL,
      remote_object_key TEXT NOT NULL,
      mime_type TEXT,
      byte_size INTEGER,
      sha256 TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      state TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      protected_reason TEXT,
      PRIMARY KEY (auth_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS media_cache_entries_conversation_idx
      ON media_cache_entries (auth_id, conversation_id, state, last_accessed_at);

    CREATE INDEX IF NOT EXISTS media_cache_entries_attachment_idx
      ON media_cache_entries (auth_id, attachment_id, variant);

    CREATE INDEX IF NOT EXISTS media_cache_entries_lru_idx
      ON media_cache_entries (auth_id, pinned, state, last_accessed_at);

    CREATE TABLE IF NOT EXISTS sync_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auth_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      from_cursor INTEGER NOT NULL DEFAULT 0,
      to_cursor INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `,
    )
    .then(async () => {
      await ensureColumn(db, 'outbox_messages', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');

      const row = await db.getFirstAsync<JsonRow>(
        'SELECT value FROM chat_meta WHERE key = ?',
        'schema_version',
      );
      if (row?.value === String(CHAT_SYNC_SCHEMA_VERSION)) {
        void logDebugEvent('info', 'chat-sync-store', 'Chat sync schema ready', {
          schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
        });
        return;
      }

      void logDebugEvent(
        'warn',
        'chat-sync-store',
        'Resetting chat sync replica for schema upgrade',
        {
          schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
        },
      );
      await enqueueDbWrite(() =>
        db.withExclusiveTransactionAsync(async (txn) => {
          await txn.runAsync('DELETE FROM local_conversations');
          await txn.runAsync('DELETE FROM local_memberships');
          await txn.runAsync('DELETE FROM local_messages');
          await txn.runAsync('DELETE FROM local_message_attachments');
          await txn.runAsync('DELETE FROM local_attachment_variants');
          await txn.runAsync('DELETE FROM outbox_messages');
          await txn.runAsync('DELETE FROM media_outbox_messages');
          await txn.runAsync('DELETE FROM media_outbox_attachments');
          await txn.runAsync('DELETE FROM media_upload_sessions');
          await txn.runAsync('DELETE FROM media_upload_parts');
          await txn.runAsync('DELETE FROM media_cache_entries');
          await txn.runAsync('DELETE FROM sync_journal');
          await txn.runAsync(
            'INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)',
            'schema_version',
            String(CHAT_SYNC_SCHEMA_VERSION),
          );
        }),
      );
    });

  await schemaPromise;

  return db;
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = await db.getAllAsync<TableInfoRow>(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  void logDebugEvent('warn', 'chat-sync-store', 'Repairing missing SQLite column', {
    columnName,
    tableName,
  });
  await db.execAsync(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

export async function getChatSyncCursor(authId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<CursorRow>(
    'SELECT value AS cursor FROM chat_meta WHERE key = ?',
    cursorKey(authId),
  );

  return Number(row?.cursor ?? 0);
}

export async function setChatSyncCursor(authId: string, cursor: number): Promise<void> {
  const db = await getDb();

  await enqueueDbWrite(() => writeChatSyncCursor(db, authId, cursor));
}

export async function applyChatBootstrap(
  authId: string,
  conversations: ConversationRecord[],
  memberships: ConversationMembershipRecord[],
  cursor: number,
): Promise<void> {
  const db = await getDb();

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync('DELETE FROM local_conversations WHERE auth_id = ?', authId);
      await txn.runAsync('DELETE FROM local_memberships WHERE auth_id = ?', authId);
      for (const conversation of conversations) {
        await writeConversationRow(txn, authId, conversation);
      }
      for (const membership of memberships) {
        await writeMembershipRow(txn, authId, membership);
      }
      await writeChatSyncCursor(txn, authId, cursor);
    }),
  );
}

export async function applyChatSyncEvents(
  authId: string,
  events: ConversationEventRecord[],
  cursor: number,
): Promise<void> {
  if (events.length === 0) {
    await setChatSyncCursor(authId, cursor);
    return;
  }

  const db = await getDb();

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      for (const event of events) {
        const payload = normalizeEventPayload(event.payload);
        const isTerminalCurrentUserMembership =
          (event.type === 'membership.left' || event.type === 'membership.removed') &&
          payload.membership?.user === authId;
        if (isTerminalCurrentUserMembership) {
          await removeConversationReplica(txn, authId, event.conversation);
          continue;
        }
        const terminalMembership = (payload.memberships ?? []).find(
          (membership) => membership.user === authId && membership.status !== 'active',
        );
        if (terminalMembership) {
          await removeConversationReplica(txn, authId, event.conversation);
          continue;
        }
        if (payload.conversation) {
          await writeConversationRow(txn, authId, payload.conversation);
        }
        if (payload.membership) {
          await writeMembershipRow(txn, authId, payload.membership);
        }
        for (const membership of payload.memberships ?? []) {
          await writeMembershipRow(txn, authId, membership);
        }
        if (payload.message) {
          if (event.type === 'message.deleted') {
            await removeMessageRow(txn, authId, payload.message.id);
          } else {
            await writeMessageRow(txn, authId, payload.message);
            await writeMediaReplicaRows(
              txn,
              authId,
              payload.attachments ?? [],
              payload.attachmentVariants ?? [],
            );
            await confirmOutboxMessage(txn, authId, payload.message);
            await confirmMediaOutboxMessage(txn, authId, payload.message);
          }
        }
      }
      await writeChatSyncCursor(txn, authId, cursor);
    }),
  );
}

export async function applyConversationHistory(
  authId: string,
  messages: MessageRecord[],
  attachments: MessageAttachmentRecord[] = [],
  attachmentVariants: AttachmentVariantRecord[] = [],
): Promise<void> {
  if (messages.length === 0 && attachments.length === 0 && attachmentVariants.length === 0) {
    return;
  }

  const db = await getDb();

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      for (const message of messages) {
        await writeMessageRow(txn, authId, message);
        await confirmOutboxMessage(txn, authId, message);
        await confirmMediaOutboxMessage(txn, authId, message);
      }
      await writeMediaReplicaRows(txn, authId, attachments, attachmentVariants);
    }),
  );
}

export async function applyLocalChatRecords(
  authId: string,
  records: {
    attachmentVariants?: AttachmentVariantRecord[];
    attachments?: MessageAttachmentRecord[];
    conversation?: ConversationRecord;
    membership?: ConversationMembershipRecord;
    message?: MessageRecord;
  },
): Promise<void> {
  const db = await getDb();

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      if (records.conversation) {
        await writeConversationRow(txn, authId, records.conversation);
      }
      if (records.membership) {
        await writeMembershipRow(txn, authId, records.membership);
      }
      if (records.message) {
        await writeMessageRow(txn, authId, records.message);
        await writeMediaReplicaRows(
          txn,
          authId,
          records.attachments ?? [],
          records.attachmentVariants ?? [],
        );
        await confirmOutboxMessage(txn, authId, records.message);
        await confirmMediaOutboxMessage(txn, authId, records.message);
      }
    }),
  );
}

export async function removeLocalConversation(
  authId: string,
  conversationId: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync((txn) =>
      removeConversationReplica(txn, authId, conversationId),
    ),
  );
}

export async function removeLocalMessages(authId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  const db = await getDb();
  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      for (const messageId of messageIds) {
        await removeMessageRow(txn, authId, messageId);
      }
    }),
  );
}

export async function enqueueMediaOutboxMessage(
  authId: string,
  input: EnqueueMediaOutboxMessageInput,
): Promise<LocalMediaOutboxMessageWithAttachments> {
  if (input.attachments.length === 0) {
    throw new Error('Media messages require at least one attachment.');
  }

  const db = await getDb();
  const now = new Date().toISOString();
  const clientMessageId = input.clientMessageId ?? newClientMessageId();
  const message: LocalMediaOutboxMessage = {
    attempt_count: 0,
    auth_id: authId,
    body: input.body?.trim() ?? '',
    client_created_at: now,
    client_message_id: clientMessageId,
    conversation_id: input.conversationId,
    kind: input.kind,
    state: 'queued',
    updated_at: now,
  };
  const attachments = input.attachments.map(
    (attachment, index): LocalMediaOutboxAttachment => ({
      auth_id: authId,
      blurhash: attachment.blurhash ?? null,
      byte_size: attachment.byteSize,
      client_attachment_id: attachment.clientAttachmentId ?? newClientAttachmentId(),
      client_message_id: clientMessageId,
      conversation_id: input.conversationId,
      duration_ms: attachment.durationMs ?? null,
      height: attachment.height ?? null,
      kind: attachment.kind,
      local_uri: attachment.localUri,
      mime_type: attachment.mimeType,
      ordinal: attachment.ordinal ?? index,
      original_name: attachment.originalName,
      poster_local_uri: attachment.posterLocalUri ?? null,
      sha256: attachment.sha256 ?? null,
      state: 'queued',
      thumbnail_local_uri: attachment.thumbnailLocalUri ?? null,
      updated_at: now,
      width: attachment.width ?? null,
    }),
  );

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync(
        `INSERT INTO media_outbox_messages
          (auth_id, attempt_count, client_message_id, conversation_id, kind, body, state, client_created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.auth_id,
        message.attempt_count ?? 0,
        message.client_message_id,
        message.conversation_id,
        message.kind,
        message.body,
        message.state,
        message.client_created_at,
        message.updated_at,
      );
      for (const attachment of attachments) {
        await writeMediaOutboxAttachment(txn, attachment);
      }
    }),
  );

  void logDebugEvent('info', 'media-outbox', 'Queued media message', {
    attachmentCount: attachments.length,
    clientMessageId,
    conversationId: input.conversationId,
    kind: input.kind,
  });

  return { ...message, attachments };
}

export async function listPendingMediaOutboxMessages(
  authId: string,
): Promise<LocalMediaOutboxMessageWithAttachments[]> {
  const db = await getDb();
  const now = new Date().toISOString();
  const rows = await db.getAllAsync<LocalMediaOutboxMessage>(
    `SELECT * FROM media_outbox_messages
     WHERE auth_id = ? AND state IN ('queued', 'starting_uploads', 'uploading', 'ready_to_send', 'retry_wait', 'sending_create')
       AND (state != 'retry_wait' OR next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY client_created_at ASC`,
    authId,
    now,
  );

  return hydrateMediaOutboxMessages(authId, rows);
}

export async function listMediaOutboxMessagesForConversation(
  authId: string,
  conversationId: string,
): Promise<LocalMediaOutboxMessageWithAttachments[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaOutboxMessage>(
    `SELECT * FROM media_outbox_messages
     WHERE auth_id = ? AND conversation_id = ? AND state != 'confirmed' AND state != 'canceled'
     ORDER BY client_created_at ASC`,
    authId,
    conversationId,
  );

  return hydrateMediaOutboxMessages(authId, rows);
}

export async function listMediaUploadSessionsForMessage(
  authId: string,
  clientMessageId: string,
): Promise<LocalMediaUploadSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaUploadSession>(
    `SELECT * FROM media_upload_sessions
     WHERE auth_id = ? AND client_message_id = ?
     ORDER BY client_attachment_id ASC, variant ASC`,
    authId,
    clientMessageId,
  );

  return rows;
}

export async function upsertMediaUploadSession(
  authId: string,
  input: UpsertMediaUploadSessionInput,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `INSERT INTO media_upload_sessions
        (auth_id, client_message_id, client_attachment_id, variant, upload_session_id, attachment_id,
         conversation_id, attachment_kind, local_uri, original_name, mime_type, byte_size, width, height,
         duration_ms, sha256, blurhash, storage_profile_id, profile_json, object_key, upload_id,
         upload_mode, part_size, part_count, presigned_url, presigned_method, presigned_headers_json,
         presigned_expires_at, state, expires_at, completed_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(auth_id, client_attachment_id, variant) DO UPDATE SET
         upload_session_id = excluded.upload_session_id,
         attachment_id = excluded.attachment_id,
         conversation_id = excluded.conversation_id,
         attachment_kind = excluded.attachment_kind,
         local_uri = excluded.local_uri,
         original_name = excluded.original_name,
         mime_type = excluded.mime_type,
         byte_size = excluded.byte_size,
         width = excluded.width,
         height = excluded.height,
         duration_ms = excluded.duration_ms,
         sha256 = excluded.sha256,
         blurhash = excluded.blurhash,
         storage_profile_id = excluded.storage_profile_id,
         profile_json = excluded.profile_json,
         object_key = excluded.object_key,
         upload_id = excluded.upload_id,
         upload_mode = excluded.upload_mode,
         part_size = excluded.part_size,
         part_count = excluded.part_count,
         presigned_url = excluded.presigned_url,
         presigned_method = excluded.presigned_method,
         presigned_headers_json = excluded.presigned_headers_json,
         presigned_expires_at = excluded.presigned_expires_at,
         state = excluded.state,
         expires_at = excluded.expires_at,
         completed_at = excluded.completed_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      authId,
      input.clientMessageId,
      input.clientAttachmentId,
      input.variant,
      input.uploadSessionId ?? null,
      input.attachmentId ?? null,
      input.conversationId,
      input.attachmentKind,
      input.localUri,
      input.originalName,
      input.mimeType,
      input.byteSize,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      input.sha256 ?? null,
      input.blurhash ?? null,
      input.storageProfileId ?? null,
      input.profileJson ?? null,
      input.objectKey ?? null,
      input.uploadId ?? null,
      input.uploadMode ?? null,
      input.partSize ?? null,
      input.partCount ?? null,
      input.presignedUrl ?? null,
      input.presignedMethod ?? null,
      input.presignedHeadersJson ?? null,
      input.presignedExpiresAt ?? null,
      input.state ?? 'pending',
      input.expiresAt ?? null,
      input.completedAt ?? null,
      input.lastError ?? null,
      now,
    ),
  );
}

export async function upsertMediaUploadPart(
  authId: string,
  input: UpsertMediaUploadPartInput,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `INSERT INTO media_upload_parts
        (auth_id, client_message_id, client_attachment_id, variant, part_number, upload_session_id,
         offset_bytes, byte_size, etag, signed_url, signed_url_method, signed_url_headers_json,
         signed_url_expires_at, state, attempt_count, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(auth_id, client_attachment_id, variant, part_number) DO UPDATE SET
         upload_session_id = excluded.upload_session_id,
         offset_bytes = excluded.offset_bytes,
         byte_size = excluded.byte_size,
         etag = excluded.etag,
         signed_url = excluded.signed_url,
         signed_url_method = excluded.signed_url_method,
         signed_url_headers_json = excluded.signed_url_headers_json,
         signed_url_expires_at = excluded.signed_url_expires_at,
         state = excluded.state,
         attempt_count = excluded.attempt_count,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      authId,
      input.clientMessageId,
      input.clientAttachmentId,
      input.variant,
      input.partNumber,
      input.uploadSessionId ?? null,
      input.offsetBytes,
      input.byteSize,
      input.etag ?? null,
      input.signedUrl ?? null,
      input.signedUrlMethod ?? null,
      input.signedUrlHeadersJson ?? null,
      input.signedUrlExpiresAt ?? null,
      input.state ?? 'pending',
      input.attemptCount ?? 0,
      input.lastError ?? null,
      now,
    ),
  );
}

export async function listMediaUploadPartsForSession(
  authId: string,
  clientAttachmentId: string,
  variant: LocalMediaVariant,
): Promise<LocalMediaUploadPart[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaUploadPart>(
    `SELECT * FROM media_upload_parts
     WHERE auth_id = ? AND client_attachment_id = ? AND variant = ?
     ORDER BY part_number ASC`,
    authId,
    clientAttachmentId,
    variant,
  );

  return rows;
}

export async function listCompletedMediaUploadSessionsForMessage(
  authId: string,
  clientMessageId: string,
): Promise<CompletedMediaUploadSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaUploadSession>(
    `SELECT * FROM media_upload_sessions
     WHERE auth_id = ? AND client_message_id = ? AND variant = 'original' AND state = 'completed' AND upload_session_id IS NOT NULL
     ORDER BY client_attachment_id ASC`,
    authId,
    clientMessageId,
  );

  return rows.filter((row): row is CompletedMediaUploadSession => !!row.upload_session_id);
}

export async function markMediaOutboxState(
  authId: string,
  clientMessageId: string,
  state: LocalMediaOutboxState,
  error?: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_outbox_messages
       SET state = ?, last_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ?`,
      state,
      error ?? null,
      new Date().toISOString(),
      authId,
      clientMessageId,
    ),
  );
}

export async function markMediaOutboxRetry(
  authId: string,
  clientMessageId: string,
  error: string,
  nextAttemptDelayMs: number,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + nextAttemptDelayMs).toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_outbox_messages
       SET state = 'retry_wait', attempt_count = attempt_count + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ?`,
      error,
      nextAttemptAt,
      now,
      authId,
      clientMessageId,
    ),
  );
}

export async function markMediaAttachmentState(
  authId: string,
  clientAttachmentId: string,
  state: LocalMediaAttachmentState,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_outbox_attachments
       SET state = ?, updated_at = ?
       WHERE auth_id = ? AND client_attachment_id = ?`,
      state,
      new Date().toISOString(),
      authId,
      clientAttachmentId,
    ),
  );
}

export async function markMediaUploadSessionState(
  authId: string,
  clientAttachmentId: string,
  variant: LocalMediaVariant,
  state: LocalMediaUploadSessionState,
  error?: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_upload_sessions
       SET state = ?, last_error = ?, updated_at = ?
       WHERE auth_id = ? AND client_attachment_id = ? AND variant = ?`,
      state,
      error ?? null,
      new Date().toISOString(),
      authId,
      clientAttachmentId,
      variant,
    ),
  );
}

export async function markMediaUploadPartState(
  authId: string,
  clientAttachmentId: string,
  variant: LocalMediaVariant,
  partNumber: number,
  state: LocalMediaUploadPartState,
  etag?: string | null,
  error?: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_upload_parts
       SET state = ?, etag = COALESCE(?, etag), last_error = ?, updated_at = ?
       WHERE auth_id = ? AND client_attachment_id = ? AND variant = ? AND part_number = ?`,
      state,
      etag ?? null,
      error ?? null,
      new Date().toISOString(),
      authId,
      clientAttachmentId,
      variant,
      partNumber,
    ),
  );
}

export async function resetMediaOutboxMessageForRetry(
  authId: string,
  clientMessageId: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE media_outbox_messages
       SET state = 'queued', attempt_count = 0, last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ? AND state = 'failed_terminal'`,
      new Date().toISOString(),
      authId,
      clientMessageId,
    ),
  );
}

export async function cancelMediaOutboxMessage(
  authId: string,
  clientMessageId: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      const now = new Date().toISOString();
      await txn.runAsync(
        `UPDATE media_outbox_messages
         SET state = 'canceled', updated_at = ?
         WHERE auth_id = ? AND client_message_id = ? AND state IN ('queued', 'starting_uploads', 'uploading', 'ready_to_send', 'retry_wait', 'failed_terminal')`,
        now,
        authId,
        clientMessageId,
      );
      await txn.runAsync(
        `UPDATE media_outbox_attachments
         SET state = 'canceled', updated_at = ?
         WHERE auth_id = ? AND client_message_id = ? AND state != 'uploaded'`,
        now,
        authId,
        clientMessageId,
      );
    }),
  );
}

export async function upsertMediaCacheEntry(
  authId: string,
  input: UpsertMediaCacheEntryInput,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `INSERT INTO media_cache_entries
        (auth_id, cache_key, conversation_id, message_id, attachment_id, variant, local_uri,
         remote_object_key, mime_type, byte_size, sha256, width, height, duration_ms, state,
         last_accessed_at, created_at, pinned, protected_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(auth_id, cache_key) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         message_id = excluded.message_id,
         attachment_id = excluded.attachment_id,
         variant = excluded.variant,
         local_uri = excluded.local_uri,
         remote_object_key = excluded.remote_object_key,
         mime_type = excluded.mime_type,
         byte_size = excluded.byte_size,
         sha256 = excluded.sha256,
         width = excluded.width,
         height = excluded.height,
         duration_ms = excluded.duration_ms,
         state = excluded.state,
         last_accessed_at = excluded.last_accessed_at,
         pinned = excluded.pinned,
         protected_reason = excluded.protected_reason`,
      authId,
      input.cacheKey,
      input.conversationId,
      input.messageId,
      input.attachmentId,
      input.variant,
      input.localUri,
      input.remoteObjectKey,
      input.mimeType ?? null,
      input.byteSize ?? null,
      input.sha256 ?? null,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      input.state ?? 'available',
      now,
      now,
      input.pinned ? 1 : 0,
      input.protectedReason ?? null,
    ),
  );
}

export async function getMediaCacheEntry(
  authId: string,
  cacheKey: string,
): Promise<LocalMediaCacheEntry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<LocalMediaCacheEntry>(
    'SELECT * FROM media_cache_entries WHERE auth_id = ? AND cache_key = ? LIMIT 1',
    authId,
    cacheKey,
  );

  return row ?? null;
}

export async function touchMediaCacheEntry(authId: string, cacheKey: string): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      'UPDATE media_cache_entries SET last_accessed_at = ? WHERE auth_id = ? AND cache_key = ?',
      new Date().toISOString(),
      authId,
      cacheKey,
    ),
  );
}

export async function listMediaCacheEntriesForConversation(
  authId: string,
  conversationId: string,
): Promise<LocalMediaCacheEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaCacheEntry>(
    `SELECT * FROM media_cache_entries
     WHERE auth_id = ? AND conversation_id = ?
     ORDER BY last_accessed_at DESC`,
    authId,
    conversationId,
  );

  return rows;
}

export async function listEvictableMediaCacheEntries(
  authId: string,
  limit: number,
): Promise<LocalMediaCacheEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalMediaCacheEntry>(
    `SELECT * FROM media_cache_entries
     WHERE auth_id = ? AND pinned = 0 AND protected_reason IS NULL AND state = 'available'
     ORDER BY last_accessed_at ASC
     LIMIT ?`,
    authId,
    limit,
  );

  return rows;
}

export async function listLocalConversations(authId: string): Promise<ConversationRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_conversations
     WHERE auth_id = ?
     ORDER BY last_message_seq DESC, updated_at DESC`,
    authId,
  );

  return rows.map((row) => JSON.parse(row.value) as ConversationRecord);
}

export async function getLocalConversation(
  authId: string,
  conversationId: string,
): Promise<ConversationRecord> {
  const db = await getDb();
  const row = await db.getFirstAsync<JsonRow>(
    'SELECT value FROM local_conversations WHERE auth_id = ? AND id = ?',
    authId,
    conversationId,
  );

  if (!row) {
    throw new Error('Conversation was not found in the local chat replica.');
  }

  return JSON.parse(row.value) as ConversationRecord;
}

export async function listLocalMemberships(
  authId: string,
): Promise<ConversationMembershipRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_memberships
     WHERE auth_id = ?
     ORDER BY conversation_id ASC, user_id ASC`,
    authId,
  );

  return rows.map((row) => JSON.parse(row.value) as ConversationMembershipRecord);
}

export async function listLocalMembershipsForConversation(
  authId: string,
  conversationId: string,
): Promise<ConversationMembershipRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_memberships
     WHERE auth_id = ? AND conversation_id = ? AND status = 'active'
     ORDER BY user_id ASC`,
    authId,
    conversationId,
  );

  return rows.map((row) => JSON.parse(row.value) as ConversationMembershipRecord);
}

export async function getLocalCurrentMembership(
  authId: string,
  conversationId: string,
): Promise<ConversationMembershipRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<JsonRow>(
    `SELECT value FROM local_memberships
     WHERE auth_id = ? AND conversation_id = ? AND user_id = ? AND status = 'active'
     LIMIT 1`,
    authId,
    conversationId,
    authId,
  );

  return row ? (JSON.parse(row.value) as ConversationMembershipRecord) : null;
}

export async function listLocalMessages(
  authId: string,
  conversationId: string,
): Promise<MessageRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_messages
     WHERE auth_id = ? AND conversation_id = ?
     ORDER BY message_seq ASC, id ASC`,
    authId,
    conversationId,
  );

  return rows.map((row) => JSON.parse(row.value) as MessageRecord);
}

export async function listLocalMessageAttachments(
  authId: string,
  conversationId: string,
): Promise<MessageAttachmentRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_message_attachments
     WHERE auth_id = ? AND conversation_id = ?
     ORDER BY message_id ASC, ordinal ASC, id ASC`,
    authId,
    conversationId,
  );

  return rows.map((row) => JSON.parse(row.value) as MessageAttachmentRecord);
}

export async function listLocalAttachmentVariants(
  authId: string,
  conversationId: string,
): Promise<AttachmentVariantRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_attachment_variants
     WHERE auth_id = ? AND conversation_id = ?
     ORDER BY message_id ASC, attachment_id ASC, variant ASC, id ASC`,
    authId,
    conversationId,
  );

  return rows.map((row) => JSON.parse(row.value) as AttachmentVariantRecord);
}

export async function listRecentLocalMessages(
  authId: string,
  conversationId: string,
  limit: number,
): Promise<MessageRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM (
       SELECT value, message_seq, id FROM local_messages
       WHERE auth_id = ? AND conversation_id = ?
       ORDER BY message_seq DESC, id DESC
       LIMIT ?
     )
     ORDER BY message_seq ASC, id ASC`,
    authId,
    conversationId,
    limit,
  );

  return rows.map((row) => JSON.parse(row.value) as MessageRecord);
}

export async function listLocalMessagesFromSeq(
  authId: string,
  conversationId: string,
  fromSeq: number,
): Promise<MessageRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM local_messages
     WHERE auth_id = ? AND conversation_id = ? AND message_seq >= ?
     ORDER BY message_seq ASC, id ASC`,
    authId,
    conversationId,
    fromSeq,
  );

  return rows.map((row) => JSON.parse(row.value) as MessageRecord);
}

export async function listLocalMessagesBeforeSeq(
  authId: string,
  conversationId: string,
  beforeSeq: number,
  limit: number,
): Promise<MessageRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JsonRow>(
    `SELECT value FROM (
       SELECT value, message_seq, id FROM local_messages
       WHERE auth_id = ? AND conversation_id = ? AND message_seq > 0 AND message_seq < ?
       ORDER BY message_seq DESC, id DESC
       LIMIT ?
     )
     ORDER BY message_seq ASC, id ASC`,
    authId,
    conversationId,
    beforeSeq,
    limit,
  );

  return rows.map((row) => JSON.parse(row.value) as MessageRecord);
}

export async function getEarliestLocalMessageSeq(
  authId: string,
  conversationId: string,
): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ message_seq: number }>(
    `SELECT message_seq FROM local_messages
     WHERE auth_id = ? AND conversation_id = ? AND message_seq > 0
     ORDER BY message_seq ASC, id ASC
     LIMIT 1`,
    authId,
    conversationId,
  );

  return row?.message_seq ?? null;
}

export async function enqueueTextOutboxMessage(
  authId: string,
  conversationId: string,
  body: string,
): Promise<LocalOutboxMessage> {
  const db = await getDb();
  const now = new Date().toISOString();
  const message: LocalOutboxMessage = {
    attempt_count: 0,
    auth_id: authId,
    body,
    client_created_at: now,
    client_message_id: newClientMessageId(),
    conversation_id: conversationId,
    state: 'queued',
    updated_at: now,
  };

  await enqueueDbWrite(() =>
    db.runAsync(
      `INSERT INTO outbox_messages
        (auth_id, attempt_count, client_message_id, conversation_id, body, state, client_created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.auth_id,
      message.attempt_count ?? 0,
      message.client_message_id,
      message.conversation_id,
      message.body,
      message.state,
      message.client_created_at,
      message.updated_at,
    ),
  );

  void logDebugEvent('info', 'outbox', 'Queued text message', {
    clientMessageId: message.client_message_id,
    conversationId,
  });

  return message;
}

export async function listPendingOutboxMessages(authId: string): Promise<LocalOutboxMessage[]> {
  const db = await getDb();
  const now = new Date().toISOString();
  const rows = await db.getAllAsync<LocalOutboxMessage>(
    `SELECT * FROM outbox_messages
     WHERE auth_id = ? AND state IN ('queued', 'retry_wait', 'sending_create')
       AND (state != 'retry_wait' OR next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY client_created_at ASC`,
    authId,
    now,
  );

  return rows;
}

export async function listOutboxMessagesForConversation(
  authId: string,
  conversationId: string,
): Promise<LocalOutboxMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalOutboxMessage>(
    `SELECT * FROM outbox_messages
     WHERE auth_id = ? AND conversation_id = ? AND state != 'confirmed' AND state != 'canceled'
     ORDER BY client_created_at ASC`,
    authId,
    conversationId,
  );

  return rows;
}

export async function markOutboxSending(authId: string, clientMessageId: string): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE outbox_messages
       SET state = 'sending_create', updated_at = ?
       WHERE auth_id = ? AND client_message_id = ?`,
      new Date().toISOString(),
      authId,
      clientMessageId,
    ),
  );

  void logDebugEvent('info', 'outbox', 'Marked message sending', {
    clientMessageId,
  });
}

export async function markOutboxRetry(
  authId: string,
  clientMessageId: string,
  error: string,
  nextAttemptDelayMs: number,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + nextAttemptDelayMs).toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE outbox_messages
       SET state = 'retry_wait', attempt_count = attempt_count + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ?`,
      error,
      nextAttemptAt,
      now,
      authId,
      clientMessageId,
    ),
  );

  void logDebugEvent('warn', 'outbox', 'Scheduled message retry', {
    clientMessageId,
    error,
    nextAttemptDelayMs,
  });
}

export async function resetOutboxMessageForRetry(
  authId: string,
  clientMessageId: string,
): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE outbox_messages
       SET state = 'queued', attempt_count = 0, last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ? AND state = 'failed_terminal'`,
      new Date().toISOString(),
      authId,
      clientMessageId,
    ),
  );

  void logDebugEvent('info', 'outbox', 'Reset failed message for manual retry', {
    clientMessageId,
  });
}

export async function cancelOutboxMessage(authId: string, clientMessageId: string): Promise<void> {
  const db = await getDb();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE outbox_messages
       SET state = 'canceled', updated_at = ?
       WHERE auth_id = ? AND client_message_id = ? AND state IN ('queued', 'retry_wait', 'failed_terminal')`,
      new Date().toISOString(),
      authId,
      clientMessageId,
    ),
  );

  void logDebugEvent('info', 'outbox', 'Canceled failed local message', {
    clientMessageId,
  });
}

export async function markOutboxTerminalFailure(
  authId: string,
  clientMessageId: string,
  error: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await enqueueDbWrite(() =>
    db.runAsync(
      `UPDATE outbox_messages
       SET state = 'failed_terminal', last_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE auth_id = ? AND client_message_id = ?`,
      error,
      now,
      authId,
      clientMessageId,
    ),
  );

  void logDebugEvent('error', 'outbox', 'Marked message terminal failure', {
    clientMessageId,
    error,
  });
}

export async function writeSyncJournal(
  authId: string,
  trigger: string,
  result: string,
  fromCursor: number,
  toCursor: number,
  error?: string,
): Promise<void> {
  const db = await getDb();

  await enqueueDbWrite(() =>
    db.runAsync(
      `INSERT INTO sync_journal
        (auth_id, trigger, from_cursor, to_cursor, result, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      authId,
      trigger,
      fromCursor,
      toCursor,
      result,
      error ?? null,
      new Date().toISOString(),
    ),
  );

  if (result === 'error') {
    void logDebugEvent('error', 'chat-sync', 'Sync journal error', {
      error,
      fromCursor,
      toCursor,
      trigger,
    });
  }
}

async function writeConversationRow(
  db: SqliteWriter,
  authId: string,
  conversation: ConversationRecord,
) {
  await db.runAsync(
    `INSERT OR REPLACE INTO local_conversations
      (auth_id, id, value, last_message_seq, latest_event_cursor, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    authId,
    conversation.id,
    JSON.stringify(conversation),
    conversation.last_message_seq ?? 0,
    conversation.latest_event_cursor ?? 0,
    conversation.updated,
  );
}

async function writeMembershipRow(
  db: SqliteWriter,
  authId: string,
  membership: ConversationMembershipRecord,
) {
  await db.runAsync(
    `INSERT OR REPLACE INTO local_memberships
      (auth_id, id, conversation_id, user_id, value, role, status, history_start_message_seq, last_read_message_seq, live_start_cursor, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    authId,
    membership.id,
    membership.conversation,
    membership.user,
    JSON.stringify(membership),
    membership.role,
    membership.status,
    membership.history_start_message_seq ?? 1,
    membership.last_read_message_seq ?? 0,
    membership.live_start_cursor ?? 0,
    membership.updated,
  );
}

async function writeMessageRow(db: SqliteWriter, authId: string, message: MessageRecord) {
  await db.runAsync(
    `INSERT OR REPLACE INTO local_messages
      (auth_id, conversation_id, id, client_message_id, value, message_seq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    authId,
    message.conversation,
    message.id,
    message.client_message_id ?? null,
    JSON.stringify(message),
    message.message_seq ?? 0,
    message.updated,
  );
}

async function writeMediaReplicaRows(
  db: SqliteWriter,
  authId: string,
  attachments: MessageAttachmentRecord[],
  attachmentVariants: AttachmentVariantRecord[],
) {
  for (const attachment of attachments) {
    await db.runAsync(
      `INSERT OR REPLACE INTO local_message_attachments
        (auth_id, conversation_id, message_id, id, value, ordinal, kind, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      authId,
      attachment.conversation,
      attachment.message,
      attachment.id,
      JSON.stringify(attachment),
      attachment.ordinal ?? 0,
      attachment.kind,
      attachment.updated,
    );
  }

  for (const variant of attachmentVariants) {
    const messageId = variant.message;
    const conversationId = variant.conversation;
    if (!messageId || !conversationId) {
      continue;
    }
    await db.runAsync(
      `INSERT OR REPLACE INTO local_attachment_variants
        (auth_id, conversation_id, message_id, attachment_id, id, value, variant, object_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      authId,
      conversationId,
      messageId,
      variant.attachment,
      variant.id,
      JSON.stringify(variant),
      variant.variant,
      variant.object_key,
      variant.updated,
    );
  }
}

async function removeMessageRow(db: SqliteWriter, authId: string, messageId: string) {
  await db.runAsync(
    'DELETE FROM local_attachment_variants WHERE auth_id = ? AND message_id = ?',
    authId,
    messageId,
  );
  await db.runAsync(
    'DELETE FROM local_message_attachments WHERE auth_id = ? AND message_id = ?',
    authId,
    messageId,
  );
  await db.runAsync('DELETE FROM local_messages WHERE auth_id = ? AND id = ?', authId, messageId);
}

async function removeConversationReplica(db: SqliteWriter, authId: string, conversationId: string) {
  await db.runAsync(
    'DELETE FROM local_attachment_variants WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM local_message_attachments WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM local_messages WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM local_memberships WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM outbox_messages WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM media_upload_parts WHERE auth_id = ? AND client_message_id IN (SELECT client_message_id FROM media_outbox_messages WHERE auth_id = ? AND conversation_id = ?)',
    authId,
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM media_upload_sessions WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM media_outbox_attachments WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM media_outbox_messages WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM media_cache_entries WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM local_conversations WHERE auth_id = ? AND id = ?',
    authId,
    conversationId,
  );
}

async function confirmOutboxMessage(db: SqliteWriter, authId: string, message: MessageRecord) {
  if (!message.client_message_id) {
    return;
  }

  await db.runAsync(
    `UPDATE outbox_messages
     SET state = 'confirmed', server_message_id = ?, updated_at = ?
     WHERE auth_id = ? AND client_message_id = ?`,
    message.id,
    new Date().toISOString(),
    authId,
    message.client_message_id,
  );

  void logDebugEvent('info', 'outbox', 'Confirmed message from server', {
    clientMessageId: message.client_message_id,
    serverMessageId: message.id,
  });
}

async function confirmMediaOutboxMessage(db: SqliteWriter, authId: string, message: MessageRecord) {
  if (!message.client_message_id) {
    return;
  }

  await db.runAsync(
    `UPDATE media_outbox_messages
     SET state = 'confirmed', server_message_id = ?, updated_at = ?
     WHERE auth_id = ? AND client_message_id = ?`,
    message.id,
    new Date().toISOString(),
    authId,
    message.client_message_id,
  );

  void logDebugEvent('info', 'media-outbox', 'Confirmed media message from server', {
    clientMessageId: message.client_message_id,
    serverMessageId: message.id,
  });
}

async function hydrateMediaOutboxMessages(
  authId: string,
  rows: LocalMediaOutboxMessage[],
): Promise<LocalMediaOutboxMessageWithAttachments[]> {
  if (rows.length === 0) {
    return [];
  }

  const db = await getDb();
  const result: LocalMediaOutboxMessageWithAttachments[] = [];
  for (const row of rows) {
    const attachments = await db.getAllAsync<LocalMediaOutboxAttachment>(
      `SELECT * FROM media_outbox_attachments
       WHERE auth_id = ? AND client_message_id = ?
       ORDER BY ordinal ASC, client_attachment_id ASC`,
      authId,
      row.client_message_id,
    );
    result.push({ ...row, attachments });
  }

  return result;
}

async function writeMediaOutboxAttachment(
  db: SqliteWriter,
  attachment: LocalMediaOutboxAttachment,
) {
  await db.runAsync(
    `INSERT INTO media_outbox_attachments
      (auth_id, client_message_id, client_attachment_id, conversation_id, ordinal, kind, local_uri,
       thumbnail_local_uri, poster_local_uri, original_name, mime_type, byte_size, width, height,
       duration_ms, sha256, blurhash, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attachment.auth_id,
    attachment.client_message_id,
    attachment.client_attachment_id,
    attachment.conversation_id,
    attachment.ordinal,
    attachment.kind,
    attachment.local_uri,
    attachment.thumbnail_local_uri ?? null,
    attachment.poster_local_uri ?? null,
    attachment.original_name,
    attachment.mime_type,
    attachment.byte_size,
    attachment.width ?? null,
    attachment.height ?? null,
    attachment.duration_ms ?? null,
    attachment.sha256 ?? null,
    attachment.blurhash ?? null,
    attachment.state,
    attachment.updated_at,
  );
}

async function writeChatSyncCursor(db: SqliteWriter, authId: string, cursor: number) {
  await db.runAsync(
    'INSERT OR REPLACE INTO chat_meta (key, value) VALUES (?, ?)',
    cursorKey(authId),
    String(cursor),
  );
}

function normalizeEventPayload(payload: unknown): ConversationEventPayload {
  if (typeof payload === 'string') {
    return JSON.parse(payload) as ConversationEventPayload;
  }

  return (payload ?? {}) as ConversationEventPayload;
}

function cursorKey(authId: string) {
  return `cursor:${authId}`;
}

function newClientMessageId() {
  return `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function newClientAttachmentId() {
  return `ca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
