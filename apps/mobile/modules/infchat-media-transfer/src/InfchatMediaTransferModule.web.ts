import type {
  InfchatMediaTransferModule,
  UploadFileOptions,
  UploadFilePartOptions,
  UploadResult,
} from './InfchatMediaTransfer.types';

const unsupported = async (): Promise<UploadResult> => {
  throw new Error('InfchatMediaTransfer is only available on native platforms.');
};

const module: InfchatMediaTransferModule = {
  uploadFileAsync: (_options: UploadFileOptions) => unsupported(),
  uploadFilePartAsync: (_options: UploadFilePartOptions) => unsupported(),
};

export default module;
