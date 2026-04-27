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

export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(username));
}
