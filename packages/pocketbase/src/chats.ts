import type PocketBase from 'pocketbase';

import { type AvatarImageVariant, getAvatarThumb } from './profiles';

export type ConversationKind = 'private' | 'group';
export type GroupHistoryPolicy = 'full' | 'since_join';
export type MembershipRole = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'left' | 'removed';
export type MembershipJoinSource = 'created' | 'added_by_member' | 'invite_link';
export type MembershipNotificationLevel = 'all' | 'mentions' | 'muted';
export type MessageKind = 'text' | 'media' | 'file' | 'voice' | 'call';

export type MessageUploadFile = {
  uri: string;
  name: string;
  type: string;
};

export type ConversationAvatarUploadFile = MessageUploadFile;

export type MediaAttachmentKind = 'image' | 'video' | 'file' | 'voice';
export type MediaUploadVariant = 'thumbnail' | 'preview' | 'original' | 'poster';
export type MediaUploadMode = 'single' | 'multipart';
export type MediaUploadSessionState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'completing'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'expired';
export type MediaUploadPartState = 'pending' | 'signed' | 'uploaded' | 'failed';

export type MediaUploadSessionRecord = {
  id: string;
  conversation: string;
  user: string;
  client_message_id: string;
  client_attachment_id: string;
  attachment_id: string;
  attachment_kind: MediaAttachmentKind;
  variant: MediaUploadVariant;
  ordinal?: number;
  storage_profile?: string;
  object_key: string;
  upload_id?: string;
  upload_mode: MediaUploadMode;
  original_name?: string;
  mime_type: string;
  byte_size: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  sha256?: string;
  blurhash?: string;
  part_size?: number;
  part_count?: number;
  state: MediaUploadSessionState;
  expires_at?: string;
  completed_at?: string;
  last_error?: string;
  created: string;
  updated: string;
};

export type MediaPresignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  expires: number;
};

export type MediaUploadPartInfo = {
  byteSize: number;
  etag?: string;
  offsetBytes: number;
  partNumber: number;
  presigned?: MediaPresignedRequest;
  providerReportedSize?: number;
  signedUrlExpiresAt?: string;
  state: MediaUploadPartState;
  uploadPartRecordId?: string;
};

export type MediaStorageProfileInfo = {
  id: string;
  driver: string;
  multipartPartSizeBytes: number;
  multipartThresholdBytes: number;
  maxObjectSizeBytes: number;
  presignTtlSeconds: number;
  supportsListParts: boolean;
  supportsMultipartUpload: boolean;
  supportsPresignedDownloads: boolean;
};

export type MediaUploadSessionResponse = {
  attachmentId: string;
  objectKey: string;
  parts?: MediaUploadPartInfo[];
  presigned?: MediaPresignedRequest;
  profile: MediaStorageProfileInfo;
  session: MediaUploadSessionRecord;
  uploadId?: string;
};

export type StartMediaUploadInput = {
  attachmentKind: MediaAttachmentKind;
  blurhash?: string;
  byteSize: number;
  clientAttachmentId: string;
  clientMessageId: string;
  conversationId: string;
  durationMs?: number;
  height?: number;
  mimeType: string;
  ordinal?: number;
  originalName?: string;
  sha256?: string;
  variant?: MediaUploadVariant;
  width?: number;
};

export type CompleteMediaUploadPartInput = {
  etag: string;
  partNumber: number;
};

export type ConversationRecord = {
  id: string;
  kind: ConversationKind;
  pair_key?: string;
  created_by?: string;
  title?: string;
  avatar?: string;
  description?: string;
  default_history_policy?: GroupHistoryPolicy;
  member_count?: number;
  next_message_seq?: number;
  next_event_seq?: number;
  latest_event_cursor?: number;
  last_message_id?: string;
  last_message_seq?: number;
  last_message_text?: string;
  last_message_at?: string;
  created: string;
  updated: string;
};

export type ConversationMembershipRecord = {
  id: string;
  conversation: string;
  user: string;
  epoch_no: number;
  role: MembershipRole;
  status: MembershipStatus;
  join_source: MembershipJoinSource;
  added_by?: string;
  removed_by?: string;
  joined_message_seq: number;
  history_start_message_seq: number;
  live_start_cursor: number;
  ended_message_seq?: number;
  ended_cursor?: number;
  ended_at?: string;
  last_read_message_seq: number;
  notification_level: MembershipNotificationLevel;
  created: string;
  updated: string;
};

export type MessageRecord = {
  id: string;
  client_message_id?: string;
  conversation: string;
  deleted_at?: string;
  deleted_by?: string;
  edited_at?: string;
  edit_version?: number;
  message_seq?: number;
  sender: string;
  sender_membership?: string;
  sender_device_id?: string;
  kind: MessageKind;
  body: string;
  call_room?: string;
  attachments?: string[];
  collectionId: string;
  collectionName: string;
  created: string;
  updated: string;
};

export type ConversationEventType =
  | 'conversation.created'
  | 'conversation.updated'
  | 'conversation.history_policy_updated'
  | 'membership.added'
  | 'membership.left'
  | 'membership.removed'
  | 'membership.role_updated'
  | 'read.updated'
  | 'message.created'
  | 'message.edited'
  | 'message.deleted'
  | 'call.started'
  | 'call.updated'
  | 'call.ended';

export type ConversationEventPayload = {
  conversation?: ConversationRecord;
  membership?: ConversationMembershipRecord;
  memberships?: ConversationMembershipRecord[];
  message?: MessageRecord;
  removed?: boolean;
};

export type ConversationEventRecord = {
  id: string;
  actor_membership?: string;
  actor_user?: string;
  conversation: string;
  cursor: number;
  event_seq: number;
  message?: string;
  payload?: ConversationEventPayload | string;
  subject_membership?: string;
  subject_user?: string;
  type: ConversationEventType;
  created: string;
  updated: string;
};

export type ChatBootstrapResponse = {
  conversations: ConversationRecord[];
  cursor: number;
  memberships: ConversationMembershipRecord[];
};

export type ChatSyncResponse = {
  cursor: number;
  events: ConversationEventRecord[];
  hasMore: boolean;
};

export type StartConversationResponse = {
  conversation: ConversationRecord;
  cursor: number;
  membership: ConversationMembershipRecord;
  memberships: ConversationMembershipRecord[];
};

export type CreateGroupInput = {
  defaultHistoryPolicy: GroupHistoryPolicy;
  memberUserIds: string[];
  title: string;
};

export type GroupMembershipsResponse = {
  conversation: ConversationRecord;
  cursor: number;
  memberships: ConversationMembershipRecord[];
};

export type GroupMembershipResponse = {
  conversation: ConversationRecord;
  cursor: number;
  membership: ConversationMembershipRecord;
};

export type UpdateGroupInput = {
  avatar?: ConversationAvatarUploadFile;
  defaultHistoryPolicy?: GroupHistoryPolicy;
  description?: string;
  title?: string;
};

export type SendTextMessageCommandInput = {
  body: string;
  clientMessageId: string;
  conversationId: string;
  deviceId: string;
};

export type SendMessageCommandResponse = {
  conversation: ConversationRecord;
  cursor: number;
  membership: ConversationMembershipRecord;
  message: MessageRecord;
  replayed: boolean;
};

export type MarkConversationReadCommandResponse = {
  cursor: number;
  membership: ConversationMembershipRecord;
};

export type MessageReadersResponse = {
  readers: ConversationMembershipRecord[];
  seenCount: number;
};

export type DeleteMessagesCommandResponse = {
  conversation: ConversationRecord;
  cursor: number;
  messages: MessageRecord[];
};

export function listConversations(pb: PocketBase): Promise<ConversationRecord[]> {
  return pb.collection('conversations').getFullList<ConversationRecord>({
    sort: '-last_message_at,-updated',
  });
}

export function getConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<ConversationRecord> {
  return pb.collection('conversations').getOne<ConversationRecord>(conversationId);
}

export async function startPrivateConversation(
  pb: PocketBase,
  recipientUserId: string,
): Promise<ConversationRecord> {
  const response = await pb.send<StartConversationResponse>(
    '/api/infchat/conversations/private/start',
    {
      body: { recipientUserId },
      method: 'POST',
    },
  );

  return response.conversation;
}

export function startPrivateConversationCommand(
  pb: PocketBase,
  recipientUserId: string,
): Promise<StartConversationResponse> {
  return pb.send('/api/infchat/conversations/private/start', {
    body: { recipientUserId },
    method: 'POST',
  });
}

export function createGroupConversation(
  pb: PocketBase,
  input: CreateGroupInput,
): Promise<StartConversationResponse> {
  return pb.send('/api/infchat/groups/create', {
    body: input,
    method: 'POST',
  });
}

export function addGroupMembers(
  pb: PocketBase,
  conversationId: string,
  memberUserIds: string[],
): Promise<GroupMembershipsResponse> {
  return pb.send(`/api/infchat/groups/${conversationId}/members/add`, {
    body: { memberUserIds },
    method: 'POST',
  });
}

export function removeGroupMember(
  pb: PocketBase,
  conversationId: string,
  userId: string,
): Promise<GroupMembershipResponse> {
  return pb.send(`/api/infchat/groups/${conversationId}/members/${userId}/remove`, {
    method: 'POST',
  });
}

export function leaveGroupConversation(
  pb: PocketBase,
  conversationId: string,
): Promise<GroupMembershipResponse> {
  return pb.send(`/api/infchat/groups/${conversationId}/leave`, {
    method: 'POST',
  });
}

export function updateGroupConversation(
  pb: PocketBase,
  conversationId: string,
  input: UpdateGroupInput,
): Promise<{ conversation: ConversationRecord; cursor: number }> {
  if (input.avatar) {
    const formData = new FormData();
    appendGroupUpdateFields(formData, input);
    formData.append('avatar', input.avatar as unknown as Blob);

    return pb.send(`/api/infchat/groups/${conversationId}`, {
      body: formData,
      method: 'PATCH',
    });
  }

  return pb.send(`/api/infchat/groups/${conversationId}`, {
    body: {
      ...(input.defaultHistoryPolicy === undefined
        ? {}
        : { defaultHistoryPolicy: input.defaultHistoryPolicy }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    method: 'PATCH',
  });
}

export function getConversationAvatarUrl(
  pb: PocketBase,
  conversation: ConversationRecord,
  fileToken?: string,
  variant: AvatarImageVariant = 'thumb',
): string | null {
  if (!conversation.avatar) {
    return null;
  }

  const thumb = getAvatarThumb(variant);

  return pb.files.getURL(conversation, conversation.avatar, {
    ...(fileToken ? { token: fileToken } : {}),
    ...(thumb ? { thumb } : {}),
  });
}

function appendGroupUpdateFields(formData: FormData, input: UpdateGroupInput) {
  if (input.defaultHistoryPolicy !== undefined) {
    formData.append('defaultHistoryPolicy', input.defaultHistoryPolicy);
  }
  if (input.description !== undefined) {
    formData.append('description', input.description);
  }
  if (input.title !== undefined) {
    formData.append('title', input.title);
  }
}

export function listMessages(pb: PocketBase, conversationId: string): Promise<MessageRecord[]> {
  return pb.collection('messages').getFullList<MessageRecord>({
    filter: pb.filter('conversation={:conversationId}', { conversationId }),
    sort: 'created',
  });
}

export function bootstrapChatSync(pb: PocketBase): Promise<ChatBootstrapResponse> {
  return pb.send('/api/infchat/bootstrap', { method: 'GET' });
}

export function syncChatEvents(
  pb: PocketBase,
  cursor: number,
  limit?: number,
): Promise<ChatSyncResponse> {
  const params = new URLSearchParams({ cursor: String(cursor) });
  if (limit) {
    params.set('limit', String(limit));
  }

  return pb.send(`/api/infchat/sync?${params.toString()}`, { method: 'GET' });
}

export function listConversationMessagesBeforeSeq(
  pb: PocketBase,
  conversationId: string,
  beforeSeq?: number,
  limit?: number,
): Promise<{ messages: MessageRecord[] }> {
  const params = new URLSearchParams();
  if (beforeSeq) {
    params.set('beforeSeq', String(beforeSeq));
  }
  if (limit) {
    params.set('limit', String(limit));
  }
  const query = params.toString();

  return pb.send(
    `/api/infchat/conversations/${conversationId}/messages${query ? `?${query}` : ''}`,
    { method: 'GET' },
  );
}

export function sendTextMessageCommand(
  pb: PocketBase,
  input: SendTextMessageCommandInput,
): Promise<SendMessageCommandResponse> {
  return pb.send('/api/infchat/messages/send', {
    body: {
      body: input.body,
      clientMessageId: input.clientMessageId,
      conversationId: input.conversationId,
      deviceId: input.deviceId,
      kind: 'text',
    },
    method: 'POST',
  });
}

export function startMediaUpload(
  pb: PocketBase,
  input: StartMediaUploadInput,
): Promise<MediaUploadSessionResponse> {
  return pb.send('/api/infchat/media/uploads/start', {
    body: input,
    method: 'POST',
  });
}

export function signMediaUploadParts(
  pb: PocketBase,
  uploadSessionId: string,
  partNumbers: number[],
): Promise<MediaUploadSessionResponse> {
  return pb.send(`/api/infchat/media/uploads/${uploadSessionId}/sign-parts`, {
    body: { partNumbers },
    method: 'POST',
  });
}

export function listMediaUploadParts(
  pb: PocketBase,
  uploadSessionId: string,
): Promise<MediaUploadSessionResponse> {
  return pb.send(`/api/infchat/media/uploads/${uploadSessionId}/parts`, {
    method: 'GET',
  });
}

export function getMediaUploadStatus(
  pb: PocketBase,
  uploadSessionId: string,
): Promise<MediaUploadSessionResponse> {
  return pb.send(`/api/infchat/media/uploads/${uploadSessionId}/status`, {
    method: 'GET',
  });
}

export function completeMediaUpload(
  pb: PocketBase,
  uploadSessionId: string,
  parts: CompleteMediaUploadPartInput[],
): Promise<MediaUploadSessionResponse> {
  return pb.send(`/api/infchat/media/uploads/${uploadSessionId}/complete`, {
    body: { parts },
    method: 'POST',
  });
}

export function abortMediaUpload(
  pb: PocketBase,
  uploadSessionId: string,
): Promise<MediaUploadSessionResponse> {
  return pb.send(`/api/infchat/media/uploads/${uploadSessionId}/abort`, {
    method: 'POST',
  });
}

export function markConversationReadBySeq(
  pb: PocketBase,
  conversationId: string,
  lastReadSeq: number,
): Promise<MarkConversationReadCommandResponse> {
  return pb.send(`/api/infchat/conversations/${conversationId}/read`, {
    body: { lastReadSeq },
    method: 'POST',
  });
}

export function listMessageReaders(
  pb: PocketBase,
  messageId: string,
): Promise<MessageReadersResponse> {
  return pb.send(`/api/infchat/messages/${messageId}/readers`, {
    method: 'GET',
  });
}

export function deleteConversationMessages(
  pb: PocketBase,
  conversationId: string,
  messageIds: string[],
): Promise<DeleteMessagesCommandResponse> {
  return pb.send(`/api/infchat/conversations/${conversationId}/messages/delete`, {
    body: { messageIds },
    method: 'POST',
  });
}

export function sendTextMessage(pb: PocketBase, conversationId: string, body: string) {
  return pb.collection('messages').create<MessageRecord>({
    body: body.trim(),
    conversation: conversationId,
    kind: 'text',
  });
}

export function sendImageMessage(
  pb: PocketBase,
  conversationId: string,
  file: MessageUploadFile,
  caption = '',
) {
  return sendAttachmentMessage(pb, conversationId, 'media', file, caption);
}

export function sendFileMessage(
  pb: PocketBase,
  conversationId: string,
  file: MessageUploadFile,
  caption = '',
) {
  return sendAttachmentMessage(pb, conversationId, 'file', file, caption || file.name);
}

export function getMessageAttachmentUrl(
  pb: PocketBase,
  message: MessageRecord,
  attachment: string,
  fileToken?: string,
  thumb?: string,
): string {
  return pb.files.getURL(message, attachment, {
    ...(fileToken ? { token: fileToken } : {}),
    ...(thumb ? { thumb } : {}),
  });
}

function sendAttachmentMessage(
  pb: PocketBase,
  conversationId: string,
  kind: Extract<MessageKind, 'media' | 'file'>,
  file: MessageUploadFile,
  caption: string,
) {
  const formData = new FormData();
  formData.append('conversation', conversationId);
  formData.append('kind', kind);
  formData.append('body', caption.trim());
  formData.append('attachments', file as unknown as Blob);

  return pb.collection('messages').create<MessageRecord>(formData);
}
