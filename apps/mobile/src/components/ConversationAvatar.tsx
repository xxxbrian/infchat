import { getConversationAvatarUrl, type ConversationRecord } from '@infchat/pocketbase';

import { avatarMediaCacheKey, useCachedRemoteUri } from '../lib/media-cache';
import { pb } from '../lib/pocketbase';
import { AvatarCircle, type AvatarProfile, ProfileAvatar } from './ProfileAvatar';

export function ConversationAvatar({
  conversation,
  fileToken,
  name,
  privateProfile,
  size,
  variant = 'thumb',
}: {
  conversation?: ConversationRecord | null;
  fileToken?: string;
  name: string;
  privateProfile?: AvatarProfile;
  size: number;
  variant?: 'thumb' | 'medium' | 'large' | 'hero';
}) {
  if (conversation?.kind === 'private') {
    const profile = privateProfile;

    return (
      <ProfileAvatar
        avatarUrl={profile?.avatarUrl}
        isOnline={profile?.isOnline}
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

  return <AvatarCircle name={name} seed={conversation?.id || name} size={size} username={name} />;
}
