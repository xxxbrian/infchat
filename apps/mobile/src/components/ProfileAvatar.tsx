import { getAvatarColor, getAvatarInitial } from '@infchat/shared';
import { Image, Text, View } from 'react-native';

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

  return (
    <View
      className="items-center justify-center overflow-hidden rounded-full"
      style={{
        backgroundColor: getAvatarColor(userId || username),
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
