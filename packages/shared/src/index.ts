export * from './cn';

import { z } from 'zod';

export const MESSAGE_KINDS = ['text', 'image', 'file', 'voice', 'call'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const CALL_ROOM_STATUSES = [
  'ringing',
  'active',
  'ended',
  'missed',
  'declined',
  'canceled',
] as const;
export type CallRoomStatus = (typeof CALL_ROOM_STATUSES)[number];

export const CALL_KINDS = ['voice', 'video'] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export type DevicePlatform = 'ios' | 'android' | 'web';

export type LiveKitParticipantMetadata = {
  userId: string;
  deviceId: string;
};

export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
export const DISPLAY_NAME_MAX_LENGTH = 48;

export const usernameSchema = z
  .string()
  .transform((value) => normalizeUsername(value))
  .pipe(
    z
      .string()
      .regex(USERNAME_PATTERN, 'Username must be 3-32 lowercase letters, numbers, or underscores'),
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required')
  .max(
    DISPLAY_NAME_MAX_LENGTH,
    `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
  );

export const friendSearchSchema = z
  .string()
  .transform((value) => normalizeUsername(value))
  .pipe(z.string().min(3, 'Enter at least 3 characters').max(32));

export const AVATAR_COLORS = [
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#34d399',
  '#f59e0b',
  '#22d3ee',
  '#fb7185',
  '#c084fc',
  '#4ade80',
  '#38bdf8',
] as const;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(username));
}

export function getAvatarColor(seed: string): (typeof AVATAR_COLORS)[number] {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getAvatarInitial(displayName: string | undefined, username: string): string {
  return (displayName?.trim() || username).slice(0, 1).toUpperCase();
}
