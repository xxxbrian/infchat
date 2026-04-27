export * from './cn';

export const MESSAGE_KINDS = ['text', 'image', 'voice'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const CALL_ROOM_STATUSES = ['ringing', 'active', 'ended'] as const;
export type CallRoomStatus = (typeof CALL_ROOM_STATUSES)[number];

export type DevicePlatform = 'ios' | 'android' | 'web';

export type LiveKitParticipantMetadata = {
  userId: string;
  deviceId: string;
};
