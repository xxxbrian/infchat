import type {
  InfchatMediaTransferModule,
  OpenDocumentOptions,
  UploadFileOptions,
  UploadFilePartOptions,
  UploadResult,
} from './InfchatMediaTransfer.types';

const unsupported = async (): Promise<UploadResult> => {
  throw new Error('InfchatMediaTransfer is only available on native platforms.');
};

const module: InfchatMediaTransferModule = {
  canInstallUnknownAppsAsync: async () => false,
  enterPictureInPictureAsync: async (_width: number, _height: number) => false,
  getNativeVersionCodeAsync: async () => 0,
  isPictureInPictureSupportedAsync: async () => false,
  installApkAsync: async (_fileUri: string) => {
    throw new Error('InfchatMediaTransfer APK installation is only available on Android.');
  },
  openDocumentAsync: async (_options: OpenDocumentOptions) => {
    throw new Error('InfchatMediaTransfer document preview is only available on native platforms.');
  },
  openInstallUnknownAppsSettingsAsync: async () => {
    throw new Error('InfchatMediaTransfer APK installation is only available on Android.');
  },
  sha256FileAsync: async (_fileUri: string) => {
    throw new Error('InfchatMediaTransfer file hashing is only available on native platforms.');
  },
  startAndroidNotificationRuntimeAsync: async (_options) => {},
  stopAndroidNotificationRuntimeAsync: async () => {},
  uploadFileAsync: (_options: UploadFileOptions) => unsupported(),
  uploadFilePartAsync: (_options: UploadFilePartOptions) => unsupported(),
};

export default module;
