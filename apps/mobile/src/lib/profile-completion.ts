import { type ProfileRecord, type ProfileSetupField } from '@infchat/pocketbase';

export const PROFILE_SETUP_FIELDS: ProfileSetupField[] = ['displayName', 'bio', 'avatar'];

export function parseProfileSetupSkippedFields(profile: ProfileRecord): Set<ProfileSetupField> {
  const skipped = new Set<ProfileSetupField>();
  const values = (profile.setup_skipped_fields ?? '').split(',');

  for (const value of values) {
    if (isProfileSetupField(value)) {
      skipped.add(value);
    }
  }

  return skipped;
}

export function getMissingProfileSetupFields(profile: ProfileRecord): ProfileSetupField[] {
  const skipped = parseProfileSetupSkippedFields(profile);

  return PROFILE_SETUP_FIELDS.filter((field) => {
    if (skipped.has(field)) {
      return false;
    }

    return isProfileSetupFieldMissing(profile, field);
  });
}

export function isProfileSetupFieldMissing(
  profile: ProfileRecord,
  field: ProfileSetupField,
): boolean {
  switch (field) {
    case 'displayName':
      return (
        !profile.display_name.trim() ||
        profile.display_name.trim().toLowerCase() === profile.username.trim().toLowerCase()
      );
    case 'bio':
      return !profile.bio?.trim();
    case 'avatar':
      return !profile.avatar;
  }
}

function isProfileSetupField(value: string): value is ProfileSetupField {
  return (PROFILE_SETUP_FIELDS as string[]).includes(value);
}
