import {
  getCurrentProfile,
  getConversation,
  listConversations,
  listFriendships,
  listMessages,
  listMessagesUpdatedAfter,
  listProfilesByUserIds,
  searchProfilesByUsername,
  type ConversationRecord,
  type FriendshipRecord,
  type MessageRecord,
  type ProfileRecord,
} from '@infchat/pocketbase';
import * as SQLite from 'expo-sqlite';
import type PocketBase from 'pocketbase';

type CacheRow = {
  value: string;
};

type SyncStateRow = {
  last_synced_at: string;
};

const dbPromise = SQLite.openDatabaseAsync('infchat-cache.db');
let schemaPromise: Promise<void> | null = null;

async function getDb() {
  const db = await dbPromise;

  schemaPromise ??= db.execAsync(`
    CREATE TABLE IF NOT EXISTS query_cache (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      scope TEXT PRIMARY KEY NOT NULL,
      last_synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations_cache (
      auth_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      last_message_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS conversations_cache_sort_idx
      ON conversations_cache (auth_id, last_message_at DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages_cache (
      auth_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );

    CREATE INDEX IF NOT EXISTS messages_cache_conversation_idx
      ON messages_cache (auth_id, conversation_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS profiles_cache (
      auth_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS friendships_cache (
      auth_id TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (auth_id, id)
    );
  `);

  await schemaPromise;

  return db;
}

async function readCachedValue<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CacheRow>('SELECT value FROM query_cache WHERE key = ?', key);

  if (!row) {
    return null;
  }

  return JSON.parse(row.value) as T;
}

async function writeCachedValue<T>(key: string, value: T): Promise<void> {
  const db = await getDb();

  await db.runAsync(
    'INSERT OR REPLACE INTO query_cache (key, value, updated_at) VALUES (?, ?, ?)',
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

async function hasSynced(scope: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<SyncStateRow>(
    'SELECT last_synced_at FROM sync_state WHERE scope = ?',
    scope,
  );

  return Boolean(row);
}

async function getLastSyncedAt(scope: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<SyncStateRow>(
    'SELECT last_synced_at FROM sync_state WHERE scope = ?',
    scope,
  );

  return row?.last_synced_at ?? null;
}

async function markSynced(scope: string): Promise<void> {
  const db = await getDb();

  await db.runAsync(
    'INSERT OR REPLACE INTO sync_state (scope, last_synced_at) VALUES (?, ?)',
    scope,
    new Date().toISOString(),
  );
}

function getAuthId(pb: PocketBase): string {
  return pb.authStore.record?.id ?? 'guest';
}

function getAuthCachePrefix(pb: PocketBase): string {
  return `auth:${getAuthId(pb)}`;
}

function parseRows<T>(rows: CacheRow[]): T[] {
  return rows.map((row) => JSON.parse(row.value) as T);
}

function sortConversations(conversations: ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((first, second) => {
    const firstTime = new Date(first.last_message_at || first.updated).getTime();
    const secondTime = new Date(second.last_message_at || second.updated).getTime();

    return secondTime - firstTime;
  });
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((first, second) => {
    const firstTime = new Date(first.created).getTime();
    const secondTime = new Date(second.created).getTime();

    return firstTime - secondTime;
  });
}

async function readCachedConversations(pb: PocketBase): Promise<ConversationRecord[] | null> {
  const db = await getDb();
  const authId = getAuthId(pb);
  const rows = await db.getAllAsync<CacheRow>(
    `SELECT value FROM conversations_cache
     WHERE auth_id = ?
     ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC`,
    authId,
  );

  if (rows.length === 0 && !(await hasSynced(`${getAuthCachePrefix(pb)}:conversations`))) {
    return null;
  }

  return parseRows<ConversationRecord>(rows);
}

export async function writeCachedConversations(
  pb: PocketBase,
  conversations: ConversationRecord[],
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  await db.runAsync('DELETE FROM conversations_cache WHERE auth_id = ?', authId);
  for (const conversation of conversations) {
    await writeCachedConversation(pb, conversation);
  }
  await markSynced(`${getAuthCachePrefix(pb)}:conversations`);
}

export async function writeCachedConversation(
  pb: PocketBase,
  conversation: ConversationRecord,
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  await db.runAsync(
    `INSERT OR REPLACE INTO conversations_cache
      (auth_id, id, value, last_message_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    authId,
    conversation.id,
    JSON.stringify(conversation),
    conversation.last_message_at ?? null,
    conversation.updated,
  );
}

export async function removeCachedConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  await db.runAsync(
    'DELETE FROM conversations_cache WHERE auth_id = ? AND id = ?',
    authId,
    conversationId,
  );
  await db.runAsync(
    'DELETE FROM messages_cache WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
}

async function readCachedConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CacheRow>(
    'SELECT value FROM conversations_cache WHERE auth_id = ? AND id = ?',
    getAuthId(pb),
    conversationId,
  );

  if (row) {
    return JSON.parse(row.value) as ConversationRecord;
  }

  const conversations = await readCachedValue<ConversationRecord[]>(
    `${getAuthCachePrefix(pb)}:conversations`,
  );

  return conversations?.find((item) => item.id === conversationId) ?? null;
}

async function readCachedMessages(
  pb: PocketBase,
  conversationId: string,
): Promise<MessageRecord[] | null> {
  const db = await getDb();
  const rows = await db.getAllAsync<CacheRow>(
    `SELECT value FROM messages_cache
     WHERE auth_id = ? AND conversation_id = ?
     ORDER BY created_at ASC`,
    getAuthId(pb),
    conversationId,
  );
  const scope = `${getAuthCachePrefix(pb)}:messages:${conversationId}`;

  if (rows.length === 0 && !(await hasSynced(scope))) {
    return null;
  }

  return parseRows<MessageRecord>(rows);
}

export async function writeCachedMessages(
  pb: PocketBase,
  conversationId: string,
  messages: MessageRecord[],
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  await db.runAsync(
    'DELETE FROM messages_cache WHERE auth_id = ? AND conversation_id = ?',
    authId,
    conversationId,
  );
  for (const message of messages) {
    await writeCachedMessage(pb, message);
  }
  await markSynced(`${getAuthCachePrefix(pb)}:messages:${conversationId}`);
}

export async function writeCachedMessage(pb: PocketBase, message: MessageRecord): Promise<void> {
  const db = await getDb();

  await db.runAsync(
    `INSERT OR REPLACE INTO messages_cache
      (auth_id, conversation_id, id, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    getAuthId(pb),
    message.conversation,
    message.id,
    JSON.stringify(message),
    message.created,
    message.updated,
  );
  await markSynced(`${getAuthCachePrefix(pb)}:messages:${message.conversation}`);
}

export async function removeCachedMessage(pb: PocketBase, message: MessageRecord): Promise<void> {
  const db = await getDb();

  await db.runAsync(
    'DELETE FROM messages_cache WHERE auth_id = ? AND id = ?',
    getAuthId(pb),
    message.id,
  );
}

async function readCachedProfilesByUserIds(
  pb: PocketBase,
  userIds: string[],
): Promise<ProfileRecord[] | null> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean).sort();
  if (uniqueUserIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const rows = await db.getAllAsync<CacheRow>(
    `SELECT value FROM profiles_cache
     WHERE auth_id = ? AND user_id IN (${uniqueUserIds.map(() => '?').join(',')})`,
    getAuthId(pb),
    ...uniqueUserIds,
  );

  if (rows.length !== uniqueUserIds.length) {
    const legacyProfiles = await readCachedValue<ProfileRecord[]>(
      `${getAuthCachePrefix(pb)}:profiles:${uniqueUserIds.join(',')}`,
    );

    if (!legacyProfiles || legacyProfiles.length !== uniqueUserIds.length) {
      return null;
    }

    return legacyProfiles;
  }

  const profilesByUserId = new Map(
    parseRows<ProfileRecord>(rows).map((profile) => [profile.user, profile]),
  );

  return uniqueUserIds.flatMap((userId) => {
    const profile = profilesByUserId.get(userId);

    return profile ? [profile] : [];
  });
}

export async function writeCachedProfiles(
  pb: PocketBase,
  profiles: ProfileRecord[],
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  for (const profile of profiles) {
    await db.runAsync(
      `INSERT OR REPLACE INTO profiles_cache
        (auth_id, user_id, id, value, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      authId,
      profile.user,
      profile.id,
      JSON.stringify(profile),
      new Date().toISOString(),
    );
  }
}

async function readCachedFriendships(pb: PocketBase): Promise<FriendshipRecord[] | null> {
  const db = await getDb();
  const rows = await db.getAllAsync<CacheRow>(
    'SELECT value FROM friendships_cache WHERE auth_id = ? ORDER BY updated_at DESC',
    getAuthId(pb),
  );
  const scope = `${getAuthCachePrefix(pb)}:friendships`;

  if (rows.length === 0 && !(await hasSynced(scope))) {
    return null;
  }

  return parseRows<FriendshipRecord>(rows);
}

export async function writeCachedFriendships(
  pb: PocketBase,
  friendships: FriendshipRecord[],
): Promise<void> {
  const db = await getDb();
  const authId = getAuthId(pb);

  await db.runAsync('DELETE FROM friendships_cache WHERE auth_id = ?', authId);
  for (const friendship of friendships) {
    await db.runAsync(
      `INSERT OR REPLACE INTO friendships_cache
        (auth_id, id, value, updated_at)
       VALUES (?, ?, ?, ?)`,
      authId,
      friendship.id,
      JSON.stringify(friendship),
      friendship.updated,
    );
  }
  await markSynced(`${getAuthCachePrefix(pb)}:friendships`);
}

async function cacheFirst<T>(
  reader: () => Promise<T | null>,
  refresher: () => Promise<T>,
): Promise<T> {
  const cachedValue = await reader();

  if (cachedValue !== null) {
    return cachedValue;
  }

  return refresher();
}

export async function refreshCachedFriendships(pb: PocketBase): Promise<FriendshipRecord[]> {
  const friendships = await listFriendships(pb);
  await writeCachedFriendships(pb, friendships);
  await writeCachedValue(`${getAuthCachePrefix(pb)}:friendships`, friendships);

  return friendships;
}

export function listCachedFriendships(pb: PocketBase): Promise<FriendshipRecord[]> {
  return cacheFirst(
    () => readCachedFriendships(pb),
    () => refreshCachedFriendships(pb),
  );
}

export async function refreshCachedCurrentProfile(pb: PocketBase): Promise<ProfileRecord> {
  const profile = await getCurrentProfile(pb);
  await writeCachedProfiles(pb, [profile]);
  await writeCachedValue(`${getAuthCachePrefix(pb)}:profile:current`, profile);

  return profile;
}

export function getCachedCurrentProfile(pb: PocketBase): Promise<ProfileRecord> {
  return cacheFirst(
    () => readCachedValue<ProfileRecord>(`${getAuthCachePrefix(pb)}:profile:current`),
    () => refreshCachedCurrentProfile(pb),
  );
}

export async function refreshCachedProfileByUserId(
  pb: PocketBase,
  userId: string,
): Promise<ProfileRecord> {
  const [profile] = await refreshCachedProfilesByUserIds(pb, [userId]);

  if (!profile) {
    throw new Error('Profile was not found');
  }

  await writeCachedValue(`${getAuthCachePrefix(pb)}:profile:${userId}`, profile);

  return profile;
}

export async function getCachedProfileByUserId(
  pb: PocketBase,
  userId: string,
): Promise<ProfileRecord> {
  return cacheFirst(
    async () => {
      const cachedProfiles = await readCachedProfilesByUserIds(pb, [userId]);

      return (
        cachedProfiles?.[0] ??
        readCachedValue<ProfileRecord>(`${getAuthCachePrefix(pb)}:profile:${userId}`)
      );
    },
    () => refreshCachedProfileByUserId(pb, userId),
  );
}

export async function refreshCachedProfilesByUserIds(
  pb: PocketBase,
  userIds: string[],
): Promise<ProfileRecord[]> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean).sort();
  const profiles = await listProfilesByUserIds(pb, uniqueUserIds);

  await writeCachedProfiles(pb, profiles);
  await writeCachedValue(`${getAuthCachePrefix(pb)}:profiles:${uniqueUserIds.join(',')}`, profiles);

  return profiles;
}

export function listCachedProfilesByUserIds(
  pb: PocketBase,
  userIds: string[],
): Promise<ProfileRecord[]> {
  return cacheFirst(
    () => readCachedProfilesByUserIds(pb, userIds),
    () => refreshCachedProfilesByUserIds(pb, userIds),
  );
}

export async function refreshCachedProfileSearch(
  pb: PocketBase,
  query: string,
): Promise<ProfileRecord[]> {
  const profiles = await searchProfilesByUsername(pb, query);

  await writeCachedProfiles(pb, profiles);
  await writeCachedValue(`${getAuthCachePrefix(pb)}:profile-search:${query}`, profiles);

  return profiles;
}

export function searchCachedProfilesByUsername(
  pb: PocketBase,
  query: string,
): Promise<ProfileRecord[]> {
  return cacheFirst(
    () => readCachedValue<ProfileRecord[]>(`${getAuthCachePrefix(pb)}:profile-search:${query}`),
    () => refreshCachedProfileSearch(pb, query),
  );
}

export async function refreshCachedConversations(pb: PocketBase): Promise<ConversationRecord[]> {
  const conversations = sortConversations(await listConversations(pb));

  await writeCachedConversations(pb, conversations);
  await writeCachedValue(`${getAuthCachePrefix(pb)}:conversations`, conversations);

  return conversations;
}

export function listCachedConversations(pb: PocketBase): Promise<ConversationRecord[]> {
  return cacheFirst(
    () => readCachedConversations(pb),
    () => refreshCachedConversations(pb),
  );
}

export async function refreshCachedConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<ConversationRecord> {
  const conversation = await getConversation(pb, conversationId);
  await writeCachedConversation(pb, conversation);

  return conversation;
}

export function getCachedConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<ConversationRecord> {
  return cacheFirst(
    async () => readCachedConversation(pb, conversationId),
    () => refreshCachedConversation(pb, conversationId),
  );
}

export async function refreshCachedMessages(
  pb: PocketBase,
  conversationId: string,
): Promise<MessageRecord[]> {
  const scope = `${getAuthCachePrefix(pb)}:messages:${conversationId}`;
  const cachedMessages = await readCachedMessages(pb, conversationId);
  const lastSyncedAt = await getLastSyncedAt(scope);

  if (cachedMessages && lastSyncedAt) {
    const updatedMessages = await listMessagesUpdatedAfter(pb, conversationId, lastSyncedAt);

    if (updatedMessages.length === 0) {
      await markSynced(scope);
      return cachedMessages;
    }

    for (const message of updatedMessages) {
      await writeCachedMessage(pb, message);
    }

    await markSynced(scope);

    return (await readCachedMessages(pb, conversationId)) ?? sortMessages(updatedMessages);
  }

  const messages = sortMessages(await listMessages(pb, conversationId));

  await writeCachedMessages(pb, conversationId, messages);
  await writeCachedValue(scope, messages);

  return messages;
}

export function listCachedMessages(
  pb: PocketBase,
  conversationId: string,
): Promise<MessageRecord[]> {
  return cacheFirst(
    () => readCachedMessages(pb, conversationId),
    () => refreshCachedMessages(pb, conversationId),
  );
}

export async function mergeCachedMessage(
  pb: PocketBase,
  message: MessageRecord,
): Promise<MessageRecord[]> {
  await writeCachedMessage(pb, message);

  return (await readCachedMessages(pb, message.conversation)) ?? [message];
}
