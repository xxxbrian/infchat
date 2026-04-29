import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { Image, Text, View } from 'react-native';

import { useCachedRemoteUri } from '../lib/media-cache';

export function ProfileAvatar({
  avatarUrl,
  name,
  size,
  userId,
  username,
}: {
  avatarUrl?: string | null;
  name?: string;
  size: number;
  userId: string;
  username: string;
}) {
  const initial = getAvatarInitial(name, username);
  const cachedAvatarUrl = useCachedRemoteUri(
    avatarUrl,
    avatarUrl ? `avatar:${userId || username}:${avatarUrl.split('?')[0]}` : undefined,
  );

  return (
    <View
      className="items-center justify-center overflow-hidden rounded-full"
      style={{
        backgroundColor: getAvatarColor(userId || username),
        height: size,
        width: size,
      }}
    >
      {cachedAvatarUrl ? (
        <Image
          source={{ uri: cachedAvatarUrl }}
          style={{
            height: size,
            width: size,
          }}
        />
      ) : (
        <Text className="font-bold text-background" style={{ fontSize: Math.max(13, size * 0.38) }}>
          {initial}
        </Text>
      )}
    </View>
  );
}
