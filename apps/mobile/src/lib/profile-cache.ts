import type { ProfileRecord } from '@infchat/pocketbase';
import type { QueryClient } from '@tanstack/react-query';
import type PocketBase from 'pocketbase';

import { writeCachedCurrentProfile } from './local-cache';

type CommitCurrentProfileUpdateInput = {
  authId: string;
  pb: PocketBase;
  profile: ProfileRecord;
  queryClient: QueryClient;
};

export async function commitCurrentProfileUpdate({
  authId,
  pb,
  profile,
  queryClient,
}: CommitCurrentProfileUpdateInput): Promise<void> {
  const currentProfileQueryKey = ['profile', 'current', authId] as const;

  // The mutation response is newer than any pending profile refresh, so commit it
  // through every cache layer before allowing background revalidation to continue.
  await queryClient.cancelQueries({ queryKey: currentProfileQueryKey });
  await writeCachedCurrentProfile(pb, profile);
  queryClient.setQueryData(currentProfileQueryKey, profile);
  queryClient.setQueriesData<ProfileRecord[]>({ queryKey: ['profiles'] }, (current) =>
    current?.map((cachedProfile) =>
      cachedProfile.user === profile.user ? profile : cachedProfile,
    ),
  );
}
