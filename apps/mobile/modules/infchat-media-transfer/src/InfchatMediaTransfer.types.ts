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

export type InfchatMediaTransferModule = {
  canInstallUnknownAppsAsync(): Promise<boolean>;
  getNativeVersionCodeAsync(): Promise<number>;
  installApkAsync(fileUri: string): Promise<void>;
  openInstallUnknownAppsSettingsAsync(): Promise<void>;
  sha256FileAsync(fileUri: string): Promise<string>;
  openDocumentAsync(options: OpenDocumentOptions): Promise<void>;
  uploadFileAsync(options: UploadFileOptions): Promise<UploadResult>;
  uploadFilePartAsync(options: UploadFilePartOptions): Promise<UploadResult>;
};
