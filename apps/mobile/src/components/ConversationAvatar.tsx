import { getConversationAvatarUrl, type ConversationRecord } from '@infchat/pocketbase';
import { View } from 'react-native';

import { avatarMediaCacheKey, useCachedRemoteUri } from '../lib/media-cache';
import { pb } from '../lib/pocketbase';
import { AvatarCircle, type AvatarProfile, ProfileAvatar } from './ProfileAvatar';

export function ConversationAvatar({
  conversation,
  fileToken,
  members,
  name,
  privateProfile,
  size,
  variant = 'thumb',
}: {
  conversation?: ConversationRecord | null;
  fileToken?: string;
  members: AvatarProfile[];
  name: string;
  privateProfile?: AvatarProfile;
  size: number;
  variant?: 'thumb' | 'medium' | 'large' | 'hero';
}) {
  if (conversation?.kind === 'private') {
    const profile = privateProfile ?? members[0];

    return (
      <ProfileAvatar
        avatarUrl={profile?.avatarUrl}
        name={profile?.name || name}
        size={size}
        userId={profile?.userId || conversation.id}
        username={profile?.username || name}
      />
    );
  }

  const groupAvatarUrl = conversation
    ? getConversationAvatarUrl(pb, conversation, fileToken, variant)
    : null;
  const cachedGroupAvatarUrl = useCachedRemoteUri(
    groupAvatarUrl,
    conversation
      ? avatarMediaCacheKey({
          fileName: conversation.avatar,
          recordId: conversation.id,
          scope: 'conversation',
          variant,
        })
      : undefined,
  );

  if (cachedGroupAvatarUrl) {
    return (
      <AvatarCircle
        avatarUrl={cachedGroupAvatarUrl}
        name={name}
        seed={conversation?.id || name}
        size={size}
        username={name}
      />
    );
  }

  return (
    <GroupAvatarMosaic members={members} name={name} seed={conversation?.id || name} size={size} />
  );
}

export function GroupAvatarMosaic({
  members,
  name,
  seed,
  size,
}: {
  members: AvatarProfile[];
  name: string;
  seed: string;
  size: number;
}) {
  const visibleMembers = members.slice(0, 4);
  if (visibleMembers.length === 0) {
    return <AvatarCircle name={name} seed={seed} size={size} username={name} />;
  }

  if (visibleMembers.length === 1) {
    const member = visibleMembers[0];

    return (
      <ProfileAvatar
        avatarUrl={member.avatarUrl}
        name={member.name}
        size={size}
        userId={member.userId}
        username={member.username}
      />
    );
  }

  const gap = Math.max(1, Math.round(size * 0.025));
  const cellSize = Math.floor((size - gap) / 2);
  const positions = [
    { left: 0, top: 0 },
    { right: 0, top: 0 },
    { bottom: 0, left: 0 },
    { bottom: 0, right: 0 },
  ];

  return (
    <View className="overflow-hidden rounded-full bg-muted" style={{ height: size, width: size }}>
      {visibleMembers.map((member, index) => (
        <View
          key={`${member.userId}:${index}`}
          style={{ position: 'absolute', ...positions[index] }}
        >
          <ProfileAvatar
            avatarUrl={member.avatarUrl}
            name={member.name}
            size={cellSize}
            userId={member.userId}
            username={member.username}
          />
        </View>
      ))}
    </View>
  );
}
