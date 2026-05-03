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
  fileName?: string | null;
};

export type ManagedMediaCacheRecordInput = MediaCacheRecordInput;

export function useCachedRemoteUri(
  remoteUri?: string | null,
  cacheKey?: string,
  cacheRecord?: MediaCacheRecordInput,
  knownLocalUri?: string | null,
): string | null {
  const [localUri, setLocalUri] = useState<string | null>(knownLocalUri ?? null);
  const cacheRecordKey = cacheRecord ? stableCacheRecordKey(cacheRecord) : '';

  useEffect(() => {
    if (knownLocalUri) {
      setLocalUri(knownLocalUri);
      if (cacheKey && cacheRecord?.authId) {
        void touchMediaCacheEntry(cacheRecord.authId, cacheKey).catch(() => {});
      }
      return;
    }

    if (!remoteUri || !cacheKey || !MEDIA_CACHE_DIRECTORY) {
      setLocalUri(null);
      return;
    }

    if (!isDownloadableRemoteUri(remoteUri)) {
      setLocalUri(remoteUri);
      return;
    }

    let isMounted = true;
    const targetUri = targetMediaCacheUri(cacheKey, remoteUri);

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
  }, [cacheKey, cacheRecord?.authId, cacheRecordKey, knownLocalUri, remoteUri]);

  return localUri ?? remoteUri ?? null;
}

export async function cacheLocalMediaFile(
  sourceUri: string,
  cacheKey: string,
  cacheRecord: MediaCacheRecordInput,
): Promise<string | null> {
  if (!MEDIA_CACHE_DIRECTORY) {
    return null;
  }

  const targetUri = targetMediaCacheUri(
    cacheKey,
    cacheRecord.fileName ?? sourceUri,
    cacheRecord.mimeType,
  );
  const targetInfo = await FileSystem.getInfoAsync(targetUri);
  if (!targetInfo.exists) {
    const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
    if (!sourceInfo.exists || sourceInfo.isDirectory) {
      return null;
    }
    await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIRECTORY, {
      intermediates: true,
    });
    await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
  }

  await persistCacheRecord(cacheKey, targetUri, cacheRecord);

  return targetUri;
}

export async function cacheRemoteMediaFile(
  remoteUri: string,
  cacheKey: string,
  cacheRecord: MediaCacheRecordInput,
): Promise<string | null> {
  if (!MEDIA_CACHE_DIRECTORY || !isDownloadableRemoteUri(remoteUri)) {
    return null;
  }

  const targetUri = targetMediaCacheUri(
    cacheKey,
    cacheRecord.fileName ?? remoteUri,
    cacheRecord.mimeType,
  );
  const targetInfo = await FileSystem.getInfoAsync(targetUri);
  if (!targetInfo.exists) {
    await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIRECTORY, {
      intermediates: true,
    });
    await FileSystem.downloadAsync(remoteUri, targetUri);
  }

  await persistCacheRecord(cacheKey, targetUri, cacheRecord);

  return targetUri;
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

function targetMediaCacheUri(
  cacheKey: string,
  sourceUri: string,
  mimeType?: string | null,
): string {
  if (!MEDIA_CACHE_DIRECTORY) {
    throw new Error('Media cache directory is not available.');
  }

  return `${MEDIA_CACHE_DIRECTORY}${hashCacheKey(cacheKey)}${getUriExtension(sourceUri, mimeType)}`;
}

function getUriExtension(uri: string, mimeType?: string | null): string {
  const path = uri.split('?')[0] ?? '';
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(path);

  if (match) {
    return `.${match[1].toLowerCase()}`;
  }

  return extensionForMimeType(mimeType);
}

function extensionForMimeType(mimeType?: string | null): string {
  switch (mimeType?.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    case 'video/x-m4v':
      return '.m4v';
    default:
      return '';
  }
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
    cacheRecord.fileName ?? '',
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
