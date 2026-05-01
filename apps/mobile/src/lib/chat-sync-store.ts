import {
  type ConversationEventPayload,
  type ConversationEventRecord,
  type ConversationMembershipRecord,
  type ConversationRecord,
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

const CHAT_SYNC_SCHEMA_VERSION = 3;
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
          await txn.runAsync('DELETE FROM outbox_messages');
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
            await confirmOutboxMessage(txn, authId, payload.message);
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
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const db = await getDb();

  await enqueueDbWrite(() =>
    db.withExclusiveTransactionAsync(async (txn) => {
      for (const message of messages) {
        await writeMessageRow(txn, authId, message);
        await confirmOutboxMessage(txn, authId, message);
      }
    }),
  );
}

export async function applyLocalChatRecords(
  authId: string,
  records: {
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
        await confirmOutboxMessage(txn, authId, records.message);
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

async function removeMessageRow(db: SqliteWriter, authId: string, messageId: string) {
  await db.runAsync('DELETE FROM local_messages WHERE auth_id = ? AND id = ?', authId, messageId);
}

async function removeConversationReplica(db: SqliteWriter, authId: string, conversationId: string) {
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
