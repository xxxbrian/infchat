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
  last_message_text?: string;
  last_message_at?: string;
  created: string;
  updated: string;
};

export type MessageRecord = {
  id: string;
  conversation: string;
  sender: string;
  kind: MessageKind;
  body: string;
  call_room?: string;
  attachments?: string[];
  collectionId: string;
  collectionName: string;
  created: string;
  updated: string;
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
