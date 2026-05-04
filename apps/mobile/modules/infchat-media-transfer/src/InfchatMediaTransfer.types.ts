export type UploadHeaderMap = Record<string, string>;

export type UploadFileOptions = {
  fileUri: string;
  headers?: UploadHeaderMap;
  method?: string;
  url: string;
};

export type UploadFilePartOptions = UploadFileOptions & {
  length: number;
  offset: number;
};

export type UploadResult = {
  body: string;
  etag?: string;
  headers: UploadHeaderMap;
  status: number;
};

export type OpenDocumentOptions = {
  fileName?: string;
  localUri: string;
  mimeType?: string | null;
  title?: string;
};

export type AndroidNotificationRuntimeOptions = {
  authToken: string;
  baseUrl: string;
  userId: string;
};

export type InfchatMediaTransferModule = {
  canInstallUnknownAppsAsync(): Promise<boolean>;
  enterPictureInPictureAsync(width: number, height: number): Promise<boolean>;
  getNativeVersionCodeAsync(): Promise<number>;
  isPictureInPictureSupportedAsync(): Promise<boolean>;
  installApkAsync(fileUri: string): Promise<void>;
  openInstallUnknownAppsSettingsAsync(): Promise<void>;
  sha256FileAsync(fileUri: string): Promise<string>;
  startAndroidNotificationRuntimeAsync(options: AndroidNotificationRuntimeOptions): Promise<void>;
  stopAndroidNotificationRuntimeAsync(): Promise<void>;
  openDocumentAsync(options: OpenDocumentOptions): Promise<void>;
  uploadFileAsync(options: UploadFileOptions): Promise<UploadResult>;
  uploadFilePartAsync(options: UploadFilePartOptions): Promise<UploadResult>;
};
