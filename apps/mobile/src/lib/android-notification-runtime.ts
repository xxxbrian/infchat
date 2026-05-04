import { Platform } from 'react-native';

import InfchatMediaTransfer from '../../modules/infchat-media-transfer';

import { pb, pocketBaseUrl } from './pocketbase';

export async function startAndroidNotificationRuntime(userId: string) {
  if (Platform.OS !== 'android' || !pb.authStore.token) {
    return;
  }

  await InfchatMediaTransfer.startAndroidNotificationRuntimeAsync({
    authToken: pb.authStore.token,
    baseUrl: pocketBaseUrl,
    userId,
  });
}

export async function stopAndroidNotificationRuntime() {
  if (Platform.OS !== 'android') {
    return;
  }

  await InfchatMediaTransfer.stopAndroidNotificationRuntimeAsync();
}
