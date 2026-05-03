import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useState } from 'react';

import {
  deleteMediaCacheEntry,
  listAvailableMediaCacheEntries,
  type LocalMediaCacheEntry,
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

export type MediaCacheUsageSummary = {
  byType: {
    files: number;
    images: number;
    other: number;
    videos: number;
    voice: number;
  };
  entryCount: number;
  totalBytes: number;
};

export type MediaCacheClearOptions = {
  conversationId?: string;
  includePinned?: boolean;
  includeProtected?: boolean;
  type?: keyof MediaCacheUsageSummary['byType'];
};

export type MediaCacheDownloadProgress = {
  bytesExpected: number | null;
  bytesWritten: number;
  progress: number | null;
};

export function useCachedRemoteUri(
  remoteUri?: string | null,
  cacheKey?: string,
  cacheRecord?: MediaCacheRecordInput,
  knownLocalUri?: string | null,
): string | null {
  const [localUri, setLocalUri] = useState<string | null>(knownLocalUri ?? null);
  const cacheRecordKey = cacheRecord ? stableCacheRecordKey(cacheRecord) : '';

  useEffect(() => {
    let isMounted = true;

    const resolveUri = async () => {
      if (knownLocalUri) {
        if (!isLocalFileUri(knownLocalUri)) {
          setLocalUri(knownLocalUri);
          return;
        }

        const knownInfo = await FileSystem.getInfoAsync(knownLocalUri).catch(() => null);
        if (!isMounted) {
          return;
        }
        if (knownInfo?.exists && !knownInfo.isDirectory) {
          setLocalUri(knownLocalUri);
          if (cacheKey && cacheRecord?.authId) {
            await touchMediaCacheEntry(cacheRecord.authId, cacheKey).catch(() => {});
          }
          return;
        }
      }

      if (!remoteUri || !cacheKey || !MEDIA_CACHE_DIRECTORY) {
        setLocalUri(null);
        return;
      }

      if (!isDownloadableRemoteUri(remoteUri)) {
        if (isLocalFileUri(remoteUri)) {
          const remoteInfo = await FileSystem.getInfoAsync(remoteUri).catch(() => null);
          if (isMounted) {
            setLocalUri(remoteInfo?.exists && !remoteInfo.isDirectory ? remoteUri : null);
          }
          return;
        }

        setLocalUri(remoteUri);
        return;
      }

      const targetUri = targetMediaCacheUri(cacheKey, remoteUri);
      const info = await FileSystem.getInfoAsync(targetUri);
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
    };

    void resolveUri().catch(() => {
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
  return downloadRemoteMediaFile(remoteUri, cacheKey, cacheRecord);
}

export async function downloadRemoteMediaFile(
  remoteUri: string,
  cacheKey: string,
  cacheRecord: MediaCacheRecordInput,
  onProgress?: (progress: MediaCacheDownloadProgress) => void,
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
  if (!targetInfo.exists || targetInfo.isDirectory) {
    if (targetInfo.isDirectory) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
    }
    await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIRECTORY, {
      intermediates: true,
    });
    const download = FileSystem.createDownloadResumable(remoteUri, targetUri, {}, (data) => {
      const bytesExpected =
        data.totalBytesExpectedToWrite > 0
          ? data.totalBytesExpectedToWrite
          : (cacheRecord.byteSize ?? null);
      onProgress?.({
        bytesExpected,
        bytesWritten: data.totalBytesWritten,
        progress: bytesExpected ? data.totalBytesWritten / bytesExpected : null,
      });
    });
    const result = await download.downloadAsync().catch(async (error) => {
      await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
      throw error;
    });
    if (!result?.uri) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
      return null;
    }
  } else {
    const bytesExpected = targetInfo.size || cacheRecord.byteSize || null;
    onProgress?.({
      bytesExpected,
      bytesWritten: bytesExpected ?? 0,
      progress: bytesExpected ? 1 : null,
    });
  }

  await persistCacheRecord(cacheKey, targetUri, cacheRecord);

  return targetUri;
}

export async function getMediaCacheUsageSummary(authId: string): Promise<MediaCacheUsageSummary> {
  const entries = await listAvailableMediaCacheEntries(authId);
  const summary: MediaCacheUsageSummary = {
    byType: {
      files: 0,
      images: 0,
      other: 0,
      videos: 0,
      voice: 0,
    },
    entryCount: entries.length,
    totalBytes: 0,
  };

  for (const entry of entries) {
    const size = await cacheEntrySize(entry.local_uri, entry.byte_size);
    summary.totalBytes += size;
    summary.byType[mediaCacheEntryType(entry)] += size;
  }

  return summary;
}

export async function clearManagedMediaCache(
  authId: string,
  options: MediaCacheClearOptions = {},
): Promise<MediaCacheUsageSummary> {
  const entries = await listAvailableMediaCacheEntries(authId);
  const cleared: MediaCacheUsageSummary = {
    byType: {
      files: 0,
      images: 0,
      other: 0,
      videos: 0,
      voice: 0,
    },
    entryCount: 0,
    totalBytes: 0,
  };

  for (const entry of entries) {
    if (!options.includePinned && entry.pinned) {
      continue;
    }
    if (!options.includeProtected && entry.protected_reason) {
      continue;
    }
    if (options.conversationId && entry.conversation_id !== options.conversationId) {
      continue;
    }
    const entryType = mediaCacheEntryType(entry);
    if (options.type && entryType !== options.type) {
      continue;
    }

    const size = await cacheEntrySize(entry.local_uri, entry.byte_size);
    await FileSystem.deleteAsync(entry.local_uri, { idempotent: true }).catch(() => {});
    await deleteMediaCacheEntry(authId, entry.cache_key);
    cleared.entryCount += 1;
    cleared.totalBytes += size;
    cleared.byType[entryType] += size;
  }

  return cleared;
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

async function cacheEntrySize(localUri: string, recordedSize?: number | null): Promise<number> {
  if (recordedSize && recordedSize > 0) {
    return recordedSize;
  }

  const info = await FileSystem.getInfoAsync(localUri).catch(() => null);
  if (info?.exists && !info.isDirectory) {
    return info.size;
  }

  return 0;
}

function mediaCacheEntryType(entry: LocalMediaCacheEntry): keyof MediaCacheUsageSummary['byType'] {
  if (entry.variant === 'file') {
    return 'files';
  }
  if (entry.variant === 'voice') {
    return 'voice';
  }
  if (entry.mime_type?.startsWith('video/')) {
    return 'videos';
  }
  if (entry.mime_type?.startsWith('image/')) {
    return 'images';
  }
  if (entry.variant === 'poster' || entry.protected_reason?.includes('video')) {
    return 'videos';
  }
  if (
    entry.variant === 'thumbnail' ||
    entry.variant === 'preview' ||
    entry.variant === 'original'
  ) {
    return 'images';
  }

  return 'other';
}

function isDownloadableRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://');
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
