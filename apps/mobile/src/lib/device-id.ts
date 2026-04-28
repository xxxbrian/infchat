import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_STORAGE_KEY = 'infchat.device.id';

export async function getDeviceId(): Promise<string> {
  const storedDeviceId = await SecureStore.getItemAsync(DEVICE_ID_STORAGE_KEY);
  if (storedDeviceId) {
    return storedDeviceId;
  }

  const deviceId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  await SecureStore.setItemAsync(DEVICE_ID_STORAGE_KEY, deviceId);

  return deviceId;
}
