import type { DocumentPickerAsset } from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { ImagePickerAsset } from 'expo-image-picker';

import type {
  EnqueueMediaOutboxAttachmentInput,
  LocalMediaAttachmentKind,
} from './chat-sync-store';

const MEDIA_OUTBOX_DIRECTORY = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}infchat-media-outbox/`
  : null;

type CopyAttachmentInput = {
  byteSize?: number | null;
  durationMs?: number | null;
  height?: number | null;
  kind: LocalMediaAttachmentKind;
  mimeType?: string | null;
  ordinal: number;
  originalName?: string | null;
  sourceUri: string;
  width?: number | null;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  avi: 'video/x-msvideo',
  bmp: 'image/bmp',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
};

export async function preparePickedMediaAttachments(
  assets: ImagePickerAsset[],
): Promise<EnqueueMediaOutboxAttachmentInput[]> {
  const attachments: EnqueueMediaOutboxAttachmentInput[] = [];

  for (const [index, asset] of assets.entries()) {
    const kind = inferPickedMediaKind(asset);
    if (!kind) {
      continue;
    }

    attachments.push(
      await copyAttachmentToOutbox({
        byteSize: asset.fileSize,
        durationMs: asset.duration,
        height: positiveNumberOrNull(asset.height),
        kind,
        mimeType: asset.mimeType,
        ordinal: index,
        originalName: asset.fileName,
        sourceUri: asset.uri,
        width: positiveNumberOrNull(asset.width),
      }),
    );
  }

  return attachments;
}

export async function preparePickedDocumentAttachments(
  assets: DocumentPickerAsset[],
): Promise<EnqueueMediaOutboxAttachmentInput[]> {
  const attachments: EnqueueMediaOutboxAttachmentInput[] = [];

  for (const [index, asset] of assets.entries()) {
    attachments.push(
      await copyAttachmentToOutbox({
        byteSize: asset.size,
        kind: 'file',
        mimeType: asset.mimeType,
        ordinal: index,
        originalName: asset.name,
        sourceUri: asset.uri,
      }),
    );
  }

  return attachments;
}

async function copyAttachmentToOutbox(
  input: CopyAttachmentInput,
): Promise<EnqueueMediaOutboxAttachmentInput> {
  if (!MEDIA_OUTBOX_DIRECTORY) {
    throw new Error('Local media outbox storage is not available on this device.');
  }

  const mimeType = inferMimeType(input.mimeType, input.originalName, input.sourceUri, input.kind);
  const originalName = displayNameWithExtension(
    input.originalName || fileNameFromUri(input.sourceUri) || defaultAttachmentName(input.kind),
    mimeType,
  );
  const targetUri = `${MEDIA_OUTBOX_DIRECTORY}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}-${sanitizeFileName(originalName)}`;

  await FileSystem.makeDirectoryAsync(MEDIA_OUTBOX_DIRECTORY, {
    intermediates: true,
  });
  await FileSystem.copyAsync({ from: input.sourceUri, to: targetUri });

  const copiedInfo = await FileSystem.getInfoAsync(targetUri);
  if (!copiedInfo.exists || copiedInfo.isDirectory) {
    throw new Error('Selected attachment could not be copied into local outbox storage.');
  }

  const byteSize = input.byteSize && input.byteSize > 0 ? input.byteSize : copiedInfo.size;
  if (byteSize <= 0) {
    throw new Error('Selected attachment is empty and cannot be sent.');
  }

  return {
    byteSize,
    durationMs: input.durationMs ?? null,
    height: input.height ?? null,
    kind: input.kind,
    localUri: targetUri,
    mimeType,
    ordinal: input.ordinal,
    originalName,
    thumbnailLocalUri: input.kind === 'image' ? targetUri : null,
    width: input.width ?? null,
  };
}

function inferPickedMediaKind(
  asset: ImagePickerAsset,
): Extract<LocalMediaAttachmentKind, 'image' | 'video'> | null {
  const mimeType = asset.mimeType?.toLowerCase() ?? '';
  if (asset.type === 'video' || mimeType.startsWith('video/')) {
    return 'video';
  }
  if (asset.type === 'image' || mimeType.startsWith('image/')) {
    return 'image';
  }

  return null;
}

function inferMimeType(
  mimeType: string | null | undefined,
  originalName: string | null | undefined,
  uri: string,
  kind: LocalMediaAttachmentKind,
): string {
  const normalizedMimeType = mimeType?.trim().toLowerCase();
  if (normalizedMimeType) {
    return normalizedMimeType;
  }

  const extension = extensionFromName(originalName || fileNameFromUri(uri) || '');
  if (extension && MIME_BY_EXTENSION[extension]) {
    return MIME_BY_EXTENSION[extension];
  }

  switch (kind) {
    case 'image':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'voice':
      return 'audio/m4a';
    default:
      return 'application/octet-stream';
  }
}

function displayNameWithExtension(name: string, mimeType: string): string {
  const safeName = sanitizeFileName(name || 'attachment');
  if (extensionFromName(safeName)) {
    return safeName;
  }

  const extension = EXTENSION_BY_MIME[mimeType];
  return extension ? `${safeName}.${extension}` : safeName;
}

function defaultAttachmentName(kind: LocalMediaAttachmentKind): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  switch (kind) {
    case 'image':
      return `photo-${stamp}.jpg`;
    case 'video':
      return `video-${stamp}.mp4`;
    case 'voice':
      return `voice-${stamp}.m4a`;
    default:
      return `file-${stamp}`;
  }
}

function fileNameFromUri(uri: string): string | null {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const decoded = decodeURIComponent(withoutQuery);
  const name = decoded.split('/').filter(Boolean).at(-1);

  return name || null;
}

function extensionFromName(name: string): string | null {
  const match = /\.([a-zA-Z0-9]{1,12})$/.exec(name.trim().split('?')[0] ?? '');

  return match?.[1]?.toLowerCase() ?? null;
}

function sanitizeFileName(name: string): string {
  const safeName = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

  return safeName || 'attachment';
}

function positiveNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}
