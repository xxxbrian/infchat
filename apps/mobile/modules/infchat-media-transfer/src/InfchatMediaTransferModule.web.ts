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
  openDocumentAsync: async (_options: OpenDocumentOptions) => {
    throw new Error('InfchatMediaTransfer document preview is only available on native platforms.');
  },
  uploadFileAsync: (_options: UploadFileOptions) => unsupported(),
  uploadFilePartAsync: (_options: UploadFilePartOptions) => unsupported(),
};

export default module;
