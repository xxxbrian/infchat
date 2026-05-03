import type PocketBase from 'pocketbase';

export type PresenceVisibility = 'everybody' | 'contacts_and_shared_chats' | 'nobody';

export type PresenceRecord = {
  approximateLabel?: string;
  isExact: boolean;
  isOnline: boolean;
  lastSeenAt?: string;
  userId: string;
};

export type PresenceQueryResponse = {
  presence: PresenceRecord[];
};

export type PresenceSessionRecord = {
  id: string;
  user: string;
  device_id: string;
  last_seen_at?: string;
  ended_at?: string;
  created: string;
  updated: string;
};

export function sendPresenceHeartbeat(
  pb: PocketBase,
  deviceId: string,
): Promise<{ session: PresenceSessionRecord }> {
  return pb.send('/api/infchat/presence/heartbeat', {
    body: { deviceId },
    method: 'POST',
  });
}

export function sendPresenceOffline(
  pb: PocketBase,
  deviceId: string,
): Promise<{ session: PresenceSessionRecord }> {
  return pb.send('/api/infchat/presence/offline', {
    body: { deviceId },
    method: 'POST',
  });
}

export function queryPresence(pb: PocketBase, userIds: string[]): Promise<PresenceQueryResponse> {
  return pb.send('/api/infchat/presence/query', {
    body: { userIds: [...new Set(userIds)].filter(Boolean).sort() },
    method: 'POST',
  });
}
