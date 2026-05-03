import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useState } from 'react';

import {
  touchMediaCacheEntry,
  type UpsertMediaCacheEntryInput,
  upsertMediaCacheEntry,
} from './chat-sync-store';

const MEDIA_CACHE_DIRECTORY = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}infchat-media/`
  : null;

type MediaCacheRecordInput = Omit<UpsertMediaCacheEntryInput, 'cacheKey' | 'localUri'> & {
  authId: string;
};

export function useCachedRemoteUri(
  remoteUri?: string | null,
  cacheKey?: string,
  cacheRecord?: MediaCacheRecordInput,
): string | null {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const cacheRecordKey = cacheRecord ? stableCacheRecordKey(cacheRecord) : '';

  useEffect(() => {
    if (!remoteUri || !cacheKey || !MEDIA_CACHE_DIRECTORY) {
      setLocalUri(null);
      return;
    }

    if (!isDownloadableRemoteUri(remoteUri)) {
      setLocalUri(remoteUri);
      return;
    }

    let isMounted = true;
    const targetUri = `${MEDIA_CACHE_DIRECTORY}${hashCacheKey(cacheKey)}${getUriExtension(remoteUri)}`;

    FileSystem.getInfoAsync(targetUri)
      .then(async (info) => {
        if (!isMounted) {
          return;
        }

        if (info.exists) {
          setLocalUri(targetUri);
          await persistCacheRecord(cacheKey, targetUri, cacheRecord);
          return;
        }

        await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIRECTORY, {
          intermediates: true,
        });
        await FileSystem.downloadAsync(remoteUri, targetUri);
        await persistCacheRecord(cacheKey, targetUri, cacheRecord);

        if (isMounted) {
          setLocalUri(targetUri);
        }
      })
      .catch(() => {
        if (isMounted) {
          setLocalUri(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [cacheKey, cacheRecordKey, remoteUri]);

  return localUri ?? remoteUri ?? null;
}

export function avatarMediaCacheKey({
  field = 'avatar',
  fileName,
  recordId,
  scope,
  variant,
}: {
  field?: string;
  fileName?: string | null;
  recordId: string;
  scope: 'conversation' | 'profile';
  variant: string;
}): string | undefined {
  if (!fileName) {
    return undefined;
  }

  return `${scope}:${recordId}:${field}:${fileName}:${variant}`;
}

function hashCacheKey(value: string): string {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function getUriExtension(uri: string): string {
  const path = uri.split('?')[0] ?? '';
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(path);

  return match ? `.${match[1].toLowerCase()}` : '';
}

function isDownloadableRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

async function persistCacheRecord(
  cacheKey: string,
  localUri: string,
  cacheRecord?: MediaCacheRecordInput,
) {
  if (!cacheRecord) {
    return;
  }

  const { authId, ...entry } = cacheRecord;
  await upsertMediaCacheEntry(authId, {
    ...entry,
    cacheKey,
    localUri,
    state: entry.state ?? 'available',
  });
  await touchMediaCacheEntry(authId, cacheKey);
}

function stableCacheRecordKey(cacheRecord: MediaCacheRecordInput): string {
  return [
    cacheRecord.authId,
    cacheRecord.conversationId,
    cacheRecord.messageId,
    cacheRecord.attachmentId,
    cacheRecord.variant,
    cacheRecord.remoteObjectKey,
    cacheRecord.mimeType ?? '',
    cacheRecord.byteSize ?? '',
    cacheRecord.sha256 ?? '',
    cacheRecord.width ?? '',
    cacheRecord.height ?? '',
    cacheRecord.durationMs ?? '',
    cacheRecord.pinned ? '1' : '0',
    cacheRecord.protectedReason ?? '',
  ].join('|');
}
