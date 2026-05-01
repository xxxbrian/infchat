import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { Image, Text, View } from 'react-native';

import { useCachedRemoteUri } from '../lib/media-cache';

export type AvatarProfile = {
  avatarUrl?: string | null;
  name?: string;
  userId: string;
  username: string;
};

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
    <AvatarCircle
      avatarUrl={cachedAvatarUrl}
      name={name}
      seed={userId || username}
      size={size}
      username={username}
    />
  );
}

export function AvatarCircle({
  avatarUrl,
  borderColor,
  borderWidth = 0,
  name,
  seed,
  size,
  username,
}: {
  avatarUrl?: string | null;
  borderColor?: string;
  borderWidth?: number;
  name?: string;
  seed: string;
  size: number;
  username: string;
}) {
  const initial = getAvatarInitial(name, username);

  return (
    <View
      className="items-center justify-center overflow-hidden rounded-full"
      style={{
        backgroundColor: getAvatarColor(seed || username),
        borderColor,
        borderWidth,
        height: size,
        width: size,
      }}
    >
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
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
