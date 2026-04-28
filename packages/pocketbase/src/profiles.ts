import { displayNameSchema, friendSearchSchema } from '@infchat/shared';
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

export type ProfileUploadFile = {
  uri: string;
  name: string;
  type: string;
};

export type UpdateProfileInput = {
  displayName: string;
  avatar?: ProfileUploadFile;
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

export async function updateProfile(
  pb: PocketBase,
  profileId: string,
  input: UpdateProfileInput,
): Promise<ProfileRecord> {
  const displayName = displayNameSchema.parse(input.displayName);

  if (!input.avatar) {
    return pb.collection('profiles').update<ProfileRecord>(profileId, {
      display_name: displayName,
    });
  }

  const formData = new FormData();
  formData.append('display_name', displayName);
  formData.append('avatar', input.avatar as unknown as Blob);

  return pb.collection('profiles').update<ProfileRecord>(profileId, formData);
}

export function getProfileAvatarUrl(
  pb: PocketBase,
  profile: ProfileRecord,
  fileToken?: string,
): string | null {
  if (!profile.avatar) {
    return null;
  }

  return pb.files.getURL(
    profile,
    profile.avatar,
    fileToken ? { thumb: '160x160', token: fileToken } : { thumb: '160x160' },
  );
}
