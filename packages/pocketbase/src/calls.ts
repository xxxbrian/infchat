import type { CallKind, CallRoomStatus } from '@infchat/shared';
import type PocketBase from 'pocketbase';

export type { CallKind };

export type CallRoomRecord = {
  id: string;
  conversation: string;
  created_by: string;
  kind: CallKind;
  room_name: string;
  status: CallRoomStatus;
  ended_at?: string;
  created: string;
  updated: string;
};

export type CallTokenResponse = {
  callRoom: CallRoomRecord;
  livekitUrl: string;
  token: string;
};

const ACTIVE_CALL_FILTER = '(status={:ringing} || status={:active})';

export function startCall(
  pb: PocketBase,
  conversationId: string,
  kind: CallKind,
  deviceId: string,
): Promise<CallTokenResponse> {
  return pb.send('/api/infchat/calls/start', {
    body: { conversationId, deviceId, kind },
    method: 'POST',
  });
}

export async function getActiveCallForConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<CallRoomRecord | null> {
  try {
    return await pb.collection('call_rooms').getFirstListItem<CallRoomRecord>(
      pb.filter(`conversation={:conversationId} && ${ACTIVE_CALL_FILTER}`, {
        active: 'active',
        conversationId,
        ringing: 'ringing',
      }),
      { sort: '-created' },
    );
  } catch {
    return null;
  }
}

export function listActiveCalls(pb: PocketBase): Promise<CallRoomRecord[]> {
  return pb.collection('call_rooms').getFullList<CallRoomRecord>({
    filter: pb.filter(ACTIVE_CALL_FILTER, {
      active: 'active',
      ringing: 'ringing',
    }),
    sort: '-created',
  });
}

export function joinCall(
  pb: PocketBase,
  callRoomId: string,
  deviceId: string,
): Promise<CallTokenResponse> {
  return pb.send(`/api/infchat/calls/${callRoomId}/join`, {
    body: { deviceId },
    method: 'POST',
  });
}

export function endCall(pb: PocketBase, callRoomId: string): Promise<{ callRoom: CallRoomRecord }> {
  return pb.send(`/api/infchat/calls/${callRoomId}/end`, {
    method: 'POST',
  });
}
