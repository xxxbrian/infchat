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
