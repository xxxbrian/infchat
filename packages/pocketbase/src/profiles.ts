import { bioSchema, displayNameSchema, friendSearchSchema } from '@infchat/shared';
import type PocketBase from 'pocketbase';

export type ProfileSetupField = 'avatar' | 'bio' | 'displayName';

export type ProfileRecord = {
  id: string;
  user: string;
  username: string;
  display_name: string;
  avatar?: string;
  bio?: string;
  collectionId: string;
  collectionName: string;
  setup_skipped_fields?: string;
};

export type ProfileUploadFile = {
  uri: string;
  name: string;
  type: string;
};

export type AvatarImageVariant = 'thumb' | 'medium' | 'large' | 'hero' | 'original';

export type UpdateProfileInput = {
  bio?: string;
  displayName?: string;
  avatar?: ProfileUploadFile;
  setupSkippedFields?: ProfileSetupField[];
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
  const data = {
    ...(input.displayName === undefined
      ? {}
      : { display_name: displayNameSchema.parse(input.displayName) }),
    ...(input.bio === undefined ? {} : { bio: bioSchema.parse(input.bio) }),
    ...(input.setupSkippedFields === undefined
      ? {}
      : {
          setup_skipped_fields: serializeProfileSetupFields(input.setupSkippedFields),
        }),
  };

  if (!input.avatar) {
    return pb.collection('profiles').update<ProfileRecord>(profileId, data);
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(data)) {
    formData.append(key, value);
  }
  formData.append('avatar', input.avatar as unknown as Blob);

  return pb.collection('profiles').update<ProfileRecord>(profileId, formData);
}

export function serializeProfileSetupFields(fields: ProfileSetupField[]): string {
  return [...new Set(fields)].sort().join(',');
}

export function getProfileAvatarUrl(
  pb: PocketBase,
  profile: ProfileRecord,
  fileToken?: string,
  variant: AvatarImageVariant = 'thumb',
): string | null {
  if (!profile.avatar) {
    return null;
  }

  const thumb = getAvatarThumb(variant);

  return pb.files.getURL(profile, profile.avatar, {
    ...(fileToken ? { token: fileToken } : {}),
    ...(thumb ? { thumb } : {}),
  });
}

export function getAvatarThumb(variant: AvatarImageVariant): string | undefined {
  switch (variant) {
    case 'thumb':
      return '96x96';
    case 'medium':
      return '160x160';
    case 'large':
      return '512x512';
    case 'hero':
      return '1024x1024';
    case 'original':
      return undefined;
  }
}
