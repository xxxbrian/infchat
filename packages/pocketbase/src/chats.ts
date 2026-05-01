import type PocketBase from 'pocketbase';

export type ConversationKind = 'private' | 'group';
export type GroupHistoryPolicy = 'full' | 'since_join';
export type MembershipRole = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'left' | 'removed';
export type MembershipJoinSource = 'created' | 'added_by_member' | 'invite_link';
export type MembershipNotificationLevel = 'all' | 'mentions' | 'muted';
export type MessageKind = 'text' | 'image' | 'file' | 'voice' | 'call';

export type MessageUploadFile = {
  uri: string;
  name: string;
  type: string;
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
  return pb.send(`/api/infchat/groups/${conversationId}`, {
    body: input,
    method: 'PATCH',
  });
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
  return sendAttachmentMessage(pb, conversationId, 'image', file, caption);
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
  kind: Extract<MessageKind, 'image' | 'file'>,
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
