import {
  type PresenceRecord,
  queryPresence,
  sendPresenceHeartbeat,
  sendPresenceOffline,
} from '@infchat/pocketbase';
import { useNetInfo } from '@react-native-community/netinfo';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import { getDeviceId } from './device-id';
import { pb } from './pocketbase';

const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

export function usePresence(userIds: string[]) {
  const sortedUserIds = useMemo(() => [...new Set(userIds)].filter(Boolean).sort(), [userIds]);

  const query = useQuery({
    queryKey: presenceQueryKey(sortedUserIds),
    queryFn: () => queryPresence(pb, sortedUserIds).then((response) => response.presence),
    enabled: sortedUserIds.length > 0,
    networkMode: 'always',
    refetchInterval: PRESENCE_HEARTBEAT_INTERVAL_MS,
  });

  return useMemo(() => {
    const byUserId = new Map<string, PresenceRecord>();
    for (const record of query.data ?? []) {
      byUserId.set(record.userId, record);
    }

    return {
      ...query,
      byUserId,
    };
  }, [query]);
}

export function presenceQueryKey(userIds?: string[]) {
  return ['presence', [...new Set(userIds ?? [])].filter(Boolean).sort()] as const;
}

export function PresenceProvider({ authId }: { authId: string }) {
  const queryClient = useQueryClient();
  const netInfo = useNetInfo();
  const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

  useEffect(() => {
    if (!authId || !isOnline) {
      return;
    }

    let isDisposed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const heartbeat = async () => {
      try {
        const deviceId = await getDeviceId();
        if (!isDisposed) {
          await sendPresenceHeartbeat(pb, deviceId);
          void queryClient.invalidateQueries({ queryKey: ['presence'] });
        }
      } catch {
        // Presence should not block the rest of the app if the network is recovering.
      }
    };
    const offline = () => {
      void getDeviceId()
        .then((deviceId) => sendPresenceOffline(pb, deviceId))
        .then(() => queryClient.invalidateQueries({ queryKey: ['presence'] }))
        .catch(() => {});
    };
    const startActiveHeartbeat = () => {
      void heartbeat();
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(heartbeat, PRESENCE_HEARTBEAT_INTERVAL_MS);
      }
    };
    const stopActiveHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      offline();
    };

    if (AppState.currentState === 'active') {
      startActiveHeartbeat();
    }

    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        startActiveHeartbeat();
        return;
      }
      stopActiveHeartbeat();
    });

    return () => {
      isDisposed = true;
      appStateSubscription.remove();
      stopActiveHeartbeat();
    };
  }, [authId, isOnline, queryClient]);

  return null;
}

export function formatPresenceLabel(presence?: PresenceRecord): string {
  if (!presence) {
    return '';
  }
  if (presence.isOnline) {
    return 'online';
  }
  if (!presence.isExact) {
    return presence.approximateLabel || 'last seen a long time ago';
  }
  if (!presence.lastSeenAt) {
    return '';
  }

  return `last seen ${formatLastSeenAt(presence.lastSeenAt)}`;
}

function formatLastSeenAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const now = new Date();
  const ageMs = Math.max(0, now.getTime() - date.getTime());
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (ageMs < minuteMs) {
    return 'just now';
  }
  if (ageMs < hourMs) {
    const minutes = Math.max(1, Math.floor(ageMs / minuteMs));
    return `${minutes}m ago`;
  }
  if (ageMs < dayMs) {
    const hours = Math.max(1, Math.floor(ageMs / hourMs));
    return `${hours}h ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `yesterday at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (ageMs < 7 * dayMs) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }

  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
