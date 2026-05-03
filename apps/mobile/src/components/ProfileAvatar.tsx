import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { Image, Text, View } from 'react-native';

import { useCachedRemoteUri } from '../lib/media-cache';

export type AvatarProfile = {
  avatarUrl?: string | null;
  isOnline?: boolean;
  name?: string;
  userId: string;
  username: string;
};

export function ProfileAvatar({
  avatarUrl,
  isOnline,
  name,
  size,
  userId,
  username,
}: {
  avatarUrl?: string | null;
  isOnline?: boolean;
  name?: string;
  size: number;
  userId: string;
  username: string;
}) {
  const cachedAvatarUrl = useCachedRemoteUri(
    avatarUrl,
    avatarUrl ? `avatar:${userId || username}:${avatarUrl.split('?')[0]}` : undefined,
  );

  return (
    <AvatarCircle
      avatarUrl={cachedAvatarUrl}
      name={name}
      seed={userId || username}
      showOnlineDot={isOnline}
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
  showOnlineDot,
  size,
  username,
}: {
  avatarUrl?: string | null;
  borderColor?: string;
  borderWidth?: number;
  name?: string;
  seed: string;
  showOnlineDot?: boolean;
  size: number;
  username: string;
}) {
  const initial = getAvatarInitial(name, username);

  return (
    <View style={{ height: size, width: size }}>
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
          <Text
            className="font-bold text-background"
            style={{ fontSize: Math.max(13, size * 0.38) }}
          >
            {initial}
          </Text>
        )}
      </View>
      {showOnlineDot ? (
        <View
          className="absolute rounded-full border-background bg-emerald-400"
          style={{
            borderWidth: Math.max(2, size * 0.055),
            bottom: 0,
            height: Math.max(12, size * 0.28),
            right: 0,
            width: Math.max(12, size * 0.28),
          }}
        />
      ) : null}
    </View>
  );
}
