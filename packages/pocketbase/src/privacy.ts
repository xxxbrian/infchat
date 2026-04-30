import type PocketBase from 'pocketbase';

export type PrivacySettingsRecord = {
  id: string;
  user: string;
  show_in_public_suggestions: boolean;
  show_in_mutual_suggestions: boolean;
  created: string;
  updated: string;
};

export type UpdatePrivacySettingsInput = {
  showInPublicSuggestions?: boolean;
  showInMutualSuggestions?: boolean;
};

export function getPrivacySettings(pb: PocketBase): Promise<PrivacySettingsRecord> {
  return pb
    .collection('privacy_settings')
    .getFirstListItem<PrivacySettingsRecord>(
      pb.filter('user={:userId}', { userId: pb.authStore.record?.id }),
    );
}

export function updatePrivacySettings(
  pb: PocketBase,
  settingsId: string,
  input: UpdatePrivacySettingsInput,
): Promise<PrivacySettingsRecord> {
  return pb.collection('privacy_settings').update<PrivacySettingsRecord>(settingsId, {
    ...(input.showInPublicSuggestions === undefined
      ? {}
      : { show_in_public_suggestions: input.showInPublicSuggestions }),
    ...(input.showInMutualSuggestions === undefined
      ? {}
      : { show_in_mutual_suggestions: input.showInMutualSuggestions }),
  });
}
