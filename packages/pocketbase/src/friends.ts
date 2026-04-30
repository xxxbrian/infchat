import type PocketBase from 'pocketbase';

import type { ProfileRecord } from './profiles';

export type FriendshipStatus = 'pending' | 'accepted' | 'declined' | 'canceled';

export type FriendshipRecord = {
  id: string;
  requester: string;
  recipient: string;
  pair_key: string;
  status: FriendshipStatus;
  accepted_at?: string;
  created: string;
  updated: string;
};

export type FriendSuggestionSource = 'mutual' | 'public';

export type FriendSuggestion = {
  mutualFriendCount: number;
  profile: ProfileRecord;
  source: FriendSuggestionSource;
};

export function listFriendships(pb: PocketBase): Promise<FriendshipRecord[]> {
  return pb.collection('friendships').getFullList<FriendshipRecord>({
    sort: '-updated',
  });
}

export function sendFriendRequest(pb: PocketBase, recipientUserId: string) {
  return pb.collection('friendships').create<FriendshipRecord>({
    recipient: recipientUserId,
  });
}

export function acceptFriendRequest(pb: PocketBase, friendshipId: string) {
  return pb.collection('friendships').update<FriendshipRecord>(friendshipId, {
    status: 'accepted',
  });
}

export function declineFriendRequest(pb: PocketBase, friendshipId: string) {
  return pb.collection('friendships').update<FriendshipRecord>(friendshipId, {
    status: 'declined',
  });
}

export function cancelFriendRequest(pb: PocketBase, friendshipId: string) {
  return pb.collection('friendships').update<FriendshipRecord>(friendshipId, {
    status: 'canceled',
  });
}

export async function listFriendSuggestions(
  pb: PocketBase,
  limit = 20,
): Promise<FriendSuggestion[]> {
  const response = await pb.send<{ suggestions: FriendSuggestion[] }>(
    `/api/infchat/friends/suggestions?limit=${limit}`,
    { method: 'GET' },
  );

  return response.suggestions;
}
