import {
  getCurrentProfile,
  getConversation,
  listConversations,
  listFriendships,
  listMessages,
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

const dbPromise = SQLite.openDatabaseAsync('infchat-cache.db');

async function getDb() {
  const db = await dbPromise;

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS query_cache (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

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
    `INSERT OR REPLACE INTO query_cache (key, value, updated_at) VALUES (?, ?, ?)`,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

async function readThroughCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const value = await fetcher();
    await writeCachedValue(key, value);
    return value;
  } catch (error) {
    const cachedValue = await readCachedValue<T>(key);

    if (cachedValue !== null) {
      return cachedValue;
    }

    throw error;
  }
}

function getAuthCachePrefix(pb: PocketBase): string {
  return `auth:${pb.authStore.record?.id ?? 'guest'}`;
}

export function listCachedFriendships(pb: PocketBase): Promise<FriendshipRecord[]> {
  return readThroughCache(`${getAuthCachePrefix(pb)}:friendships`, () => listFriendships(pb));
}

export function getCachedCurrentProfile(pb: PocketBase): Promise<ProfileRecord> {
  return readThroughCache(`${getAuthCachePrefix(pb)}:profile:current`, () => getCurrentProfile(pb));
}

export function listCachedProfilesByUserIds(
  pb: PocketBase,
  userIds: string[],
): Promise<ProfileRecord[]> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean).sort();
  const key = `${getAuthCachePrefix(pb)}:profiles:${uniqueUserIds.join(',')}`;

  return readThroughCache(key, () => listProfilesByUserIds(pb, uniqueUserIds));
}

export function searchCachedProfilesByUsername(
  pb: PocketBase,
  query: string,
): Promise<ProfileRecord[]> {
  return readThroughCache(`${getAuthCachePrefix(pb)}:profile-search:${query}`, () =>
    searchProfilesByUsername(pb, query),
  );
}

export function listCachedConversations(pb: PocketBase): Promise<ConversationRecord[]> {
  return readThroughCache(`${getAuthCachePrefix(pb)}:conversations`, () => listConversations(pb));
}

export async function getCachedConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<ConversationRecord> {
  const key = `${getAuthCachePrefix(pb)}:conversation:${conversationId}`;

  try {
    return await readThroughCache(key, () => getConversation(pb, conversationId));
  } catch (error) {
    const conversations = await readCachedValue<ConversationRecord[]>(
      `${getAuthCachePrefix(pb)}:conversations`,
    );
    const conversation = conversations?.find((item) => item.id === conversationId);

    if (conversation) {
      return conversation;
    }

    throw error;
  }
}

export function listCachedMessages(
  pb: PocketBase,
  conversationId: string,
): Promise<MessageRecord[]> {
  return readThroughCache(`${getAuthCachePrefix(pb)}:messages:${conversationId}`, () =>
    listMessages(pb, conversationId),
  );
}
