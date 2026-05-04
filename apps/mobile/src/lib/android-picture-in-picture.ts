import { Platform } from 'react-native';

import InfchatMediaTransfer from '../../modules/infchat-media-transfer';

export async function isAndroidPictureInPictureSupported() {
  if (Platform.OS !== 'android') {
    return false;
  }

  return InfchatMediaTransfer.isPictureInPictureSupportedAsync();
}

export async function enterAndroidPictureInPicture(width = 9, height = 16) {
  if (Platform.OS !== 'android') {
    return false;
  }

  return InfchatMediaTransfer.enterPictureInPictureAsync(width, height);
}
