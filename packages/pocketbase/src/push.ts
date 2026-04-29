import type PocketBase from 'pocketbase';

export type PushEnvironment = 'production' | 'sandbox';
export type PushPlatform = 'android' | 'ios';

export type PushDeviceRecord = {
  id: string;
  user: string;
  device_id: string;
  platform: PushPlatform;
  environment: PushEnvironment;
  apns_token?: string;
  voip_token?: string;
  fcm_token?: string;
  app_version?: string;
  last_seen_at?: string;
  disabled_at?: string;
  created: string;
  updated: string;
};

export type RegisterPushDeviceInput = {
  apnsToken?: string;
  appVersion?: string;
  deviceId: string;
  environment: PushEnvironment;
  fcmToken?: string;
  platform: PushPlatform;
  voipToken?: string;
};

export function registerPushDevice(
  pb: PocketBase,
  input: RegisterPushDeviceInput,
): Promise<{ pushDevice: PushDeviceRecord }> {
  return pb.send('/api/infchat/push/register', {
    body: input,
    method: 'POST',
  });
}
