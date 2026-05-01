import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useState } from 'react';

const MEDIA_CACHE_DIRECTORY = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}infchat-media/`
  : null;

export function useCachedRemoteUri(remoteUri?: string | null, cacheKey?: string): string | null {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    if (!remoteUri || !cacheKey || !MEDIA_CACHE_DIRECTORY) {
      setLocalUri(null);
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
          return;
        }

        await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIRECTORY, {
          intermediates: true,
        });
        await FileSystem.downloadAsync(remoteUri, targetUri);

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
  }, [cacheKey, remoteUri]);

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
