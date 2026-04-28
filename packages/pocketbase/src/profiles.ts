import { friendSearchSchema } from '@infchat/shared';
import type PocketBase from 'pocketbase';

export type ProfileRecord = {
  id: string;
  user: string;
  username: string;
  display_name: string;
  avatar?: string;
  collectionId: string;
  collectionName: string;
};

export async function getCurrentProfile(pb: PocketBase): Promise<ProfileRecord> {
  return pb
    .collection('profiles')
    .getFirstListItem<ProfileRecord>(
      pb.filter('user={:userId}', { userId: pb.authStore.record?.id }),
    );
}

export async function listProfilesByUserIds(
  pb: PocketBase,
  userIds: string[],
): Promise<ProfileRecord[]> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean);

  if (uniqueUserIds.length === 0) {
    return [];
  }

  return pb.collection('profiles').getFullList<ProfileRecord>({
    filter: uniqueUserIds.map((userId) => pb.filter('user={:userId}', { userId })).join(' || '),
    sort: 'display_name',
  });
}

export async function searchProfilesByUsername(
  pb: PocketBase,
  query: string,
): Promise<ProfileRecord[]> {
  const username = friendSearchSchema.parse(query);
  const currentUserId = pb.authStore.record?.id ?? '';

  return pb.collection('profiles').getFullList<ProfileRecord>({
    filter: pb.filter('username~{:username} && user!={:currentUserId}', {
      currentUserId,
      username,
    }),
    sort: 'username',
  });
}

export function getProfileAvatarUrl(pb: PocketBase, profile: ProfileRecord): string | null {
  if (!profile.avatar) {
    return null;
  }

  return pb.files.getURL(profile, profile.avatar, { thumb: '160x160' });
}
