import type PocketBase from 'pocketbase';

export type ConversationKind = 'private' | 'group';
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
  members: string[];
  title?: string;
  last_change_cursor?: number;
  last_message_id?: string;
  last_message_seq?: number;
  last_message_text?: string;
  last_message_at?: string;
  next_message_seq?: number;
  created: string;
  updated: string;
};

export type MessageRecord = {
  id: string;
  client_message_id?: string;
  conversation: string;
  deleted_at?: string;
  edited_at?: string;
  edit_version?: number;
  message_seq?: number;
  sender: string;
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

export type ConversationUserStateRecord = {
  id: string;
  conversation: string;
  user: string;
  last_read_seq: number;
  unread_count: number;
  last_delivered_cursor: number;
  created: string;
  updated: string;
};

export type ChatSyncEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'conversation.updated'
  | 'read.updated';

export type ChatSyncEventRecord = {
  id: string;
  conversation?: string;
  cursor: number;
  entity_id?: string;
  payload?: unknown;
  type: ChatSyncEventType;
  user: string;
  created: string;
  updated: string;
};

export type ChatBootstrapResponse = {
  conversations: ConversationRecord[];
  cursor: number;
  states: ConversationUserStateRecord[];
};

export type ChatSyncResponse = {
  cursor: number;
  events: ChatSyncEventRecord[];
  hasMore: boolean;
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
  message: MessageRecord;
  replayed: boolean;
};

export type MarkConversationReadCommandResponse = {
  cursor: number;
  state: ConversationUserStateRecord;
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
  const currentUserId = pb.authStore.record?.id;

  if (!currentUserId) {
    throw new Error('Sign in to start a chat.');
  }

  const pairKey = getPairKey(currentUserId, recipientUserId);

  try {
    return await pb.collection('conversations').getFirstListItem<ConversationRecord>(
      pb.filter('kind={:kind} && pair_key={:pairKey}', {
        kind: 'private',
        pairKey,
      }),
    );
  } catch {
    return pb.collection('conversations').create<ConversationRecord>({
      kind: 'private',
      members: [currentUserId, recipientUserId],
    });
  }
}

export function listMessages(pb: PocketBase, conversationId: string): Promise<MessageRecord[]> {
  return pb.collection('messages').getFullList<MessageRecord>({
    filter: pb.filter('conversation={:conversationId}', { conversationId }),
    sort: 'created',
  });
}

export function listMessagesUpdatedAfter(
  pb: PocketBase,
  conversationId: string,
  updatedAfter: string,
): Promise<MessageRecord[]> {
  return pb.collection('messages').getFullList<MessageRecord>({
    filter: pb.filter('conversation={:conversationId} && updated>{:updatedAfter}', {
      conversationId,
      updatedAfter,
    }),
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

export async function countUnreadMessages(
  pb: PocketBase,
  conversationId: string,
  lastReadAt?: string,
): Promise<number> {
  const currentUserId = pb.authStore.record?.id;

  if (!currentUserId) {
    return 0;
  }

  const filters = [
    pb.filter('conversation={:conversationId}', { conversationId }),
    pb.filter('sender!={:currentUserId}', { currentUserId }),
  ];

  if (lastReadAt) {
    filters.push(pb.filter('created>{:lastReadAt}', { lastReadAt }));
  }

  const page = await pb.collection('messages').getList<MessageRecord>(1, 1, {
    filter: filters.join(' && '),
  });

  return page.totalItems;
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

function getPairKey(firstUserId: string, secondUserId: string): string {
  return [firstUserId, secondUserId].sort().join(':');
}
