import {
  type FriendshipRecord,
  getCurrentProfile,
  listFriendships,
  listProfilesByUserIds,
  type ProfileRecord,
  searchProfilesByUsername,
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

async function markSynced(scope: string, lastSyncedAt = new Date().toISOString()): Promise<void> {
  const db = await getDb();

  await db.runAsync(
    'INSERT OR REPLACE INTO sync_state (scope, last_synced_at) VALUES (?, ?)',
    scope,
    lastSyncedAt,
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

export async function writeCachedCurrentProfile(
  pb: PocketBase,
  profile: ProfileRecord,
): Promise<void> {
  await writeCachedProfiles(pb, [profile]);
  // Keep the legacy current-profile key in sync with profiles_cache. If this key
  // stays stale, cache-first queries can briefly overwrite fresh mutation data.
  await writeCachedValue(`${getAuthCachePrefix(pb)}:profile:current`, profile);
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
  await writeCachedCurrentProfile(pb, profile);

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
