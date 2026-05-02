import {
  bootstrapChatSync,
  completeMediaUpload,
  type ConversationMembershipRecord,
  type ConversationRecord,
  type CompleteMediaUploadPartInput,
  deleteConversationMessages,
  getMediaUploadStatus,
  listConversationMessagesBeforeSeq,
  markConversationReadBySeq,
  type MediaUploadSessionResponse,
  sendMediaMessageCommand,
  sendTextMessageCommand,
  signMediaUploadParts,
  startMediaUpload,
  syncChatEvents,
} from '@infchat/pocketbase';
import type { QueryClient } from '@tanstack/react-query';
import type PocketBase from 'pocketbase';

import InfchatMediaTransfer from '../../modules/infchat-media-transfer';

import {
  applyChatBootstrap,
  applyChatSyncEvents,
  applyConversationHistory,
  applyLocalChatRecords,
  cancelOutboxMessage,
  enqueueMediaOutboxMessage,
  type EnqueueMediaOutboxMessageInput,
  enqueueTextOutboxMessage,
  getChatSyncCursor,
  type LocalMediaOutboxAttachment,
  type LocalMediaOutboxMessageWithAttachments,
  type LocalMediaUploadPart,
  type LocalMediaUploadSession,
  type LocalMediaUploadSessionState,
  listCompletedMediaUploadSessionsForMessage,
  listMediaUploadPartsForSession,
  listMediaUploadSessionsForMessage,
  listPendingMediaOutboxMessages,
  listPendingOutboxMessages,
  markMediaAttachmentState,
  markMediaOutboxRetry,
  markMediaOutboxState,
  markMediaUploadPartState,
  markMediaUploadSessionState,
  markOutboxRetry,
  markOutboxSending,
  markOutboxTerminalFailure,
  removeLocalMessages,
  resetOutboxMessageForRetry,
  upsertMediaUploadPart,
  upsertMediaUploadSession,
  writeSyncJournal,
} from './chat-sync-store';
import { logDebugEvent } from './debug-log';
import { getDeviceId } from './device-id';

export type ChatSyncTrigger =
  | 'startup'
  | 'foreground'
  | 'reconnect'
  | 'push'
  | 'realtime'
  | 'manual'
  | 'outbox';

const OUTBOX_RETRY_DELAYS_MS = [2000, 5000] as const;
const MEDIA_UPLOAD_SESSION_RETRY_DELAYS_MS = [2000, 5000, 15000] as const;

type ChatSyncServiceOptions = {
  authId: string;
  pb: PocketBase;
  queryClient: QueryClient;
};

export class ChatSyncService {
  private authId: string;
  private isOutboxRunning = false;
  private isSyncRunning = false;
  private outboxRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTriggers = new Set<ChatSyncTrigger>();
  private pb: PocketBase;
  private queryClient: QueryClient;
  private syncLoopPromise: Promise<void> | null = null;

  constructor(options: ChatSyncServiceOptions) {
    this.authId = options.authId;
    this.pb = options.pb;
    this.queryClient = options.queryClient;
  }

  start() {
    void logDebugEvent('info', 'chat-sync', 'Starting chat sync service', {
      authId: this.authId,
    });
    this.enqueueSync('startup');
    this.pumpOutbox();
  }

  dispose() {
    void logDebugEvent('info', 'chat-sync', 'Disposing chat sync service', {
      authId: this.authId,
    });
    if (this.outboxRetryTimer) {
      clearTimeout(this.outboxRetryTimer);
      this.outboxRetryTimer = null;
    }
  }

  enqueueSync(trigger: ChatSyncTrigger) {
    void logDebugEvent('debug', 'chat-sync', 'Enqueued sync trigger', {
      trigger,
    });
    this.pendingTriggers.add(trigger);
    if (trigger === 'foreground' || trigger === 'reconnect' || trigger === 'push') {
      void this.pumpOutbox();
    }
    void this.startSyncLoop();
  }

  async syncNow(trigger: ChatSyncTrigger = 'manual') {
    this.pendingTriggers.add(trigger);
    await this.startSyncLoop();
  }

  async enqueueTextMessage(conversationId: string, body: string) {
    const message = await enqueueTextOutboxMessage(this.authId, conversationId, body);
    void logDebugEvent('info', 'chat-sync', 'Enqueued local text message', {
      clientMessageId: message.client_message_id,
      conversationId,
    });
    this.invalidateChatQueries(conversationId);
    void this.pumpOutbox();

    return message;
  }

  async enqueueMediaMessage(input: EnqueueMediaOutboxMessageInput) {
    const message = await enqueueMediaOutboxMessage(this.authId, input);
    void logDebugEvent('info', 'chat-sync', 'Enqueued local media message', {
      attachmentCount: message.attachments.length,
      clientMessageId: message.client_message_id,
      conversationId: message.conversation_id,
      kind: message.kind,
    });
    this.invalidateChatQueries(message.conversation_id);
    void this.pumpOutbox();

    return message;
  }

  async retryOutboxMessage(conversationId: string, clientMessageId: string) {
    void logDebugEvent('info', 'chat-sync', 'Manual outbox retry requested', {
      clientMessageId,
      conversationId,
    });
    await resetOutboxMessageForRetry(this.authId, clientMessageId);
    this.invalidateChatQueries(conversationId);
    await this.pumpOutbox();
  }

  async cancelFailedOutboxMessage(conversationId: string, clientMessageId: string) {
    void logDebugEvent('info', 'chat-sync', 'Cancel failed outbox message requested', {
      clientMessageId,
      conversationId,
    });
    await cancelOutboxMessage(this.authId, clientMessageId);
    this.invalidateChatQueries(conversationId);
  }

  async deleteMessages(conversationId: string, messageIds: string[]) {
    if (messageIds.length === 0) {
      return;
    }

    void logDebugEvent('info', 'chat-sync', 'Deleting messages', {
      conversationId,
      messageIds,
    });
    const response = await deleteConversationMessages(this.pb, conversationId, messageIds);
    const deletedMessageIds = response.messages.map((message) => message.id);
    await applyLocalChatRecords(this.authId, {
      conversation: response.conversation,
    });
    await removeLocalMessages(this.authId, deletedMessageIds);
    this.invalidateChatQueries(conversationId);
    this.enqueueSync('manual');
  }

  async applyConversationStart(response: {
    conversation: ConversationRecord;
    membership?: ConversationMembershipRecord;
    memberships?: ConversationMembershipRecord[];
  }) {
    await applyLocalChatRecords(this.authId, {
      conversation: response.conversation,
      membership: response.membership,
    });
    for (const membership of response.memberships ?? []) {
      await applyLocalChatRecords(this.authId, {
        membership,
      });
    }
    this.invalidateChatQueries(response.conversation.id);
  }

  async syncConversationHistory(conversationId: string, beforeSeq?: number) {
    void logDebugEvent('info', 'chat-sync', 'Loading conversation history', {
      beforeSeq,
      conversationId,
    });
    const response = await listConversationMessagesBeforeSeq(
      this.pb,
      conversationId,
      beforeSeq,
      100,
    );
    await applyConversationHistory(
      this.authId,
      response.messages,
      response.attachments,
      response.attachmentVariants,
    );
    this.invalidateChatQueries(conversationId);
  }

  async markConversationRead(conversationId: string, lastReadSeq: number) {
    void logDebugEvent('debug', 'chat-sync', 'Marking conversation read', {
      conversationId,
      lastReadSeq,
    });
    const response = await markConversationReadBySeq(this.pb, conversationId, lastReadSeq);
    await applyLocalChatRecords(this.authId, {
      membership: response.membership,
    });
    this.invalidateChatQueries(conversationId);
    this.enqueueSync('manual');
  }

  private async runSyncLoop() {
    this.isSyncRunning = true;
    try {
      while (this.pendingTriggers.size > 0) {
        const trigger = [...this.pendingTriggers].join(',');
        this.pendingTriggers.clear();
        await this.syncOnce(trigger || 'manual');
      }
    } finally {
      this.isSyncRunning = false;
    }
  }

  private startSyncLoop() {
    this.syncLoopPromise ??= this.runSyncLoop().finally(() => {
      this.syncLoopPromise = null;
    });

    return this.syncLoopPromise;
  }

  private async syncOnce(trigger: string) {
    const fromCursor = await getChatSyncCursor(this.authId);
    void logDebugEvent('info', 'chat-sync', 'Sync started', {
      fromCursor,
      trigger,
    });
    try {
      if (fromCursor === 0) {
        const bootstrap = await bootstrapChatSync(this.pb);
        void logDebugEvent('info', 'chat-sync', 'Bootstrap received', {
          conversations: bootstrap.conversations.length,
          cursor: bootstrap.cursor,
          memberships: bootstrap.memberships.length,
          trigger,
        });
        await applyChatBootstrap(
          this.authId,
          bootstrap.conversations,
          bootstrap.memberships,
          bootstrap.cursor,
        );
        await writeSyncJournal(this.authId, trigger, 'success', fromCursor, bootstrap.cursor);
        await this.syncFromCursor(bootstrap.cursor);
        this.invalidateChatQueries();
        void logDebugEvent('info', 'chat-sync', 'Bootstrap sync completed', {
          cursor: bootstrap.cursor,
          trigger,
        });
        return;
      }

      const cursor = await this.syncFromCursor(fromCursor);

      await writeSyncJournal(this.authId, trigger, 'success', fromCursor, cursor);
      this.invalidateChatQueries();
      void logDebugEvent('info', 'chat-sync', 'Sync completed', {
        cursor,
        fromCursor,
        trigger,
      });
    } catch (error) {
      void logDebugEvent('error', 'chat-sync', 'Sync failed', {
        error: getErrorMessage(error),
        fromCursor,
        status: getErrorStatus(error),
        trigger,
      });
      await writeSyncJournal(
        this.authId,
        trigger,
        'error',
        fromCursor,
        fromCursor,
        getErrorMessage(error),
      );
    }
  }

  private async syncFromCursor(fromCursor: number) {
    let cursor = fromCursor;
    let hasMore = true;
    while (hasMore) {
      const response = await syncChatEvents(this.pb, cursor);
      void logDebugEvent('debug', 'chat-sync', 'Sync page received', {
        cursor: response.cursor,
        events: response.events.length,
        fromCursor: cursor,
        hasMore: response.hasMore,
      });
      await applyChatSyncEvents(this.authId, response.events, response.cursor);
      cursor = response.cursor;
      hasMore = response.hasMore;
    }

    return cursor;
  }

  private async pumpOutbox() {
    if (this.isOutboxRunning) {
      return;
    }

    this.isOutboxRunning = true;
    try {
      const deviceId = await getDeviceId();
      const pendingMessages = await listPendingOutboxMessages(this.authId);
      const pendingMediaMessages = await listPendingMediaOutboxMessages(this.authId);
      void logDebugEvent('debug', 'outbox', 'Outbox pump started', {
        pendingMediaCount: pendingMediaMessages.length,
        pendingCount: pendingMessages.length,
      });
      for (const pendingMessage of pendingMediaMessages) {
        try {
          await this.processMediaOutboxMessage(pendingMessage, deviceId);
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          const attemptCount = pendingMessage.attempt_count ?? 0;
          const retryDelayMs = MEDIA_UPLOAD_SESSION_RETRY_DELAYS_MS[attemptCount];
          if (isPermanentCommandError(error) || retryDelayMs === undefined) {
            void logDebugEvent('error', 'media-outbox', 'Media outbox failed terminally', {
              attemptCount,
              clientMessageId: pendingMessage.client_message_id,
              conversationId: pendingMessage.conversation_id,
              error: errorMessage,
              status: getErrorStatus(error),
            });
            await markMediaOutboxState(
              this.authId,
              pendingMessage.client_message_id,
              'failed_terminal',
              errorMessage,
            );
          } else {
            void logDebugEvent('warn', 'media-outbox', 'Media outbox will retry', {
              attemptCount,
              clientMessageId: pendingMessage.client_message_id,
              conversationId: pendingMessage.conversation_id,
              error: errorMessage,
              retryDelayMs,
              status: getErrorStatus(error),
            });
            await markMediaOutboxRetry(
              this.authId,
              pendingMessage.client_message_id,
              errorMessage,
              retryDelayMs,
            );
            this.scheduleOutboxRetry(retryDelayMs);
          }
        }
        this.invalidateChatQueries(pendingMessage.conversation_id);
      }
      for (const pendingMessage of pendingMessages) {
        await markOutboxSending(this.authId, pendingMessage.client_message_id);
        this.invalidateChatQueries(pendingMessage.conversation_id);
        try {
          void logDebugEvent('info', 'outbox', 'Sending outbox message', {
            attemptCount: pendingMessage.attempt_count ?? 0,
            clientMessageId: pendingMessage.client_message_id,
            conversationId: pendingMessage.conversation_id,
          });
          const response = await sendTextMessageCommand(this.pb, {
            body: pendingMessage.body,
            clientMessageId: pendingMessage.client_message_id,
            conversationId: pendingMessage.conversation_id,
            deviceId,
          });
          await applyLocalChatRecords(this.authId, {
            attachmentVariants: response.attachmentVariants,
            attachments: response.attachments,
            conversation: response.conversation,
            membership: response.membership,
            message: response.message,
          });
          void logDebugEvent('info', 'outbox', 'Outbox message sent', {
            clientMessageId: pendingMessage.client_message_id,
            serverMessageId: response.message.id,
          });
          this.enqueueSync('outbox');
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          const attemptCount = pendingMessage.attempt_count ?? 0;
          const retryDelayMs = OUTBOX_RETRY_DELAYS_MS[attemptCount];
          if (isPermanentCommandError(error) || retryDelayMs === undefined) {
            void logDebugEvent('error', 'outbox', 'Outbox message failed terminally', {
              attemptCount,
              clientMessageId: pendingMessage.client_message_id,
              conversationId: pendingMessage.conversation_id,
              error: errorMessage,
              status: getErrorStatus(error),
            });
            await markOutboxTerminalFailure(
              this.authId,
              pendingMessage.client_message_id,
              errorMessage,
            );
          } else {
            void logDebugEvent('warn', 'outbox', 'Outbox message will retry', {
              attemptCount,
              clientMessageId: pendingMessage.client_message_id,
              conversationId: pendingMessage.conversation_id,
              error: errorMessage,
              retryDelayMs,
              status: getErrorStatus(error),
            });
            await markOutboxRetry(
              this.authId,
              pendingMessage.client_message_id,
              errorMessage,
              retryDelayMs,
            );
            this.scheduleOutboxRetry(retryDelayMs);
          }
        }
        this.invalidateChatQueries(pendingMessage.conversation_id);
      }
    } finally {
      this.isOutboxRunning = false;
    }
  }

  private async prepareMediaUploadSessions(message: LocalMediaOutboxMessageWithAttachments) {
    if (message.state === 'sending_create' || message.state === 'confirmed') {
      return;
    }

    await markMediaOutboxState(this.authId, message.client_message_id, 'starting_uploads');
    void logDebugEvent('info', 'media-outbox', 'Preparing media upload sessions', {
      attachmentCount: message.attachments.length,
      clientMessageId: message.client_message_id,
      conversationId: message.conversation_id,
    });

    const sessions = await listMediaUploadSessionsForMessage(
      this.authId,
      message.client_message_id,
    );
    const originalSessionsByAttachmentId = new Map(
      sessions
        .filter((session) => session.variant === 'original')
        .map((session) => [session.client_attachment_id, session]),
    );

    let isReadyToUpload = true;
    for (const attachment of message.attachments) {
      const existing = originalSessionsByAttachmentId.get(attachment.client_attachment_id);
      if (existing?.upload_session_id) {
        const status = await getMediaUploadStatus(this.pb, existing.upload_session_id);
        await this.persistMediaUploadSessionResponse(attachment, status);
        isReadyToUpload &&= isUploadSessionReadyForTransfer(
          toLocalSessionState(status.session.state),
        );
        continue;
      }

      const response = await startMediaUpload(this.pb, {
        attachmentKind: attachment.kind,
        blurhash: attachment.blurhash ?? undefined,
        byteSize: attachment.byte_size,
        clientAttachmentId: attachment.client_attachment_id,
        clientMessageId: message.client_message_id,
        conversationId: message.conversation_id,
        durationMs: attachment.duration_ms ?? undefined,
        height: attachment.height ?? undefined,
        mimeType: attachment.mime_type,
        ordinal: attachment.ordinal,
        originalName: attachment.original_name,
        sha256: attachment.sha256 ?? undefined,
        variant: 'original',
        width: attachment.width ?? undefined,
      });
      await this.persistMediaUploadSessionResponse(attachment, response);
      await markMediaAttachmentState(
        this.authId,
        attachment.client_attachment_id,
        'session_started',
      );
      isReadyToUpload &&= isUploadSessionReadyForTransfer(
        toLocalSessionState(response.session.state),
      );
    }

    await markMediaOutboxState(
      this.authId,
      message.client_message_id,
      isReadyToUpload ? 'uploading' : 'starting_uploads',
    );
  }

  private async processMediaOutboxMessage(
    message: LocalMediaOutboxMessageWithAttachments,
    deviceId: string,
  ) {
    if (message.state === 'sending_create' || message.state === 'confirmed') {
      return;
    }

    await this.prepareMediaUploadSessions(message);
    const sessions = await listMediaUploadSessionsForMessage(
      this.authId,
      message.client_message_id,
    );
    const originalSessions = sessions.filter((session) => session.variant === 'original');
    if (originalSessions.length !== message.attachments.length) {
      throw new Error('Media upload sessions are incomplete.');
    }

    const attachmentById = new Map(
      message.attachments.map((attachment) => [attachment.client_attachment_id, attachment]),
    );
    for (const session of originalSessions) {
      const attachment = attachmentById.get(session.client_attachment_id);
      if (!attachment) {
        throw new Error('Media upload session does not match a local attachment.');
      }
      if (session.state !== 'completed') {
        await this.uploadAndCompleteMediaSession(attachment, session);
      }
    }

    await this.finalizeMediaOutboxMessage(message, deviceId);
  }

  private async uploadAndCompleteMediaSession(
    attachment: LocalMediaOutboxAttachment,
    session: LocalMediaUploadSession,
  ) {
    if (!session.upload_session_id) {
      throw new Error('Media upload session is missing its server id.');
    }
    if (session.state === 'uploaded' || session.state === 'completed') {
      await this.completeMediaSession(attachment, session);
      return;
    }
    if (session.upload_mode === 'single') {
      await this.uploadSingleMediaSession(attachment, session);
      await this.completeMediaSession(attachment, session);
      return;
    }
    if (session.upload_mode === 'multipart') {
      await this.uploadMultipartMediaSession(attachment, session);
      await this.completeMediaSession(attachment, session);
      return;
    }

    throw new Error('Media upload mode is invalid.');
  }

  private async uploadSingleMediaSession(
    attachment: LocalMediaOutboxAttachment,
    session: LocalMediaUploadSession,
  ) {
    if (!session.presigned_url || isExpired(session.presigned_expires_at)) {
      if (!session.upload_session_id) {
        throw new Error('Media upload session is missing its server id.');
      }
      const refreshed = await startMediaUpload(this.pb, {
        attachmentKind: attachment.kind,
        blurhash: attachment.blurhash ?? undefined,
        byteSize: attachment.byte_size,
        clientAttachmentId: attachment.client_attachment_id,
        clientMessageId: attachment.client_message_id,
        conversationId: attachment.conversation_id,
        durationMs: attachment.duration_ms ?? undefined,
        height: attachment.height ?? undefined,
        mimeType: attachment.mime_type,
        ordinal: attachment.ordinal,
        originalName: attachment.original_name,
        sha256: attachment.sha256 ?? undefined,
        variant: session.variant,
        width: attachment.width ?? undefined,
      });
      await this.persistMediaUploadSessionResponse(attachment, refreshed);
      session = {
        ...session,
        presigned_headers_json: refreshed.presigned
          ? JSON.stringify(refreshed.presigned.headers)
          : null,
        presigned_method: refreshed.presigned?.method ?? null,
        presigned_url: refreshed.presigned?.url ?? null,
      };
    }
    if (!session.presigned_url) {
      throw new Error('Media upload session is missing a presigned upload URL.');
    }

    await markMediaAttachmentState(this.authId, attachment.client_attachment_id, 'uploading');
    await markMediaUploadSessionState(
      this.authId,
      attachment.client_attachment_id,
      session.variant,
      'uploading',
    );
    const result = await InfchatMediaTransfer.uploadFileAsync({
      fileUri: attachment.local_uri,
      headers: parseHeaderJSON(session.presigned_headers_json),
      method: session.presigned_method ?? 'PUT',
      url: session.presigned_url,
    });
    assertSuccessfulUpload(result.status);
    await markMediaAttachmentState(this.authId, attachment.client_attachment_id, 'uploaded');
    await markMediaUploadSessionState(
      this.authId,
      attachment.client_attachment_id,
      session.variant,
      'uploaded',
    );
  }

  private async uploadMultipartMediaSession(
    attachment: LocalMediaOutboxAttachment,
    session: LocalMediaUploadSession,
  ) {
    const parts = await listMediaUploadPartsForSession(
      this.authId,
      session.client_attachment_id,
      session.variant,
    );
    if (parts.length === 0) {
      throw new Error('Multipart upload has no parts.');
    }

    await markMediaAttachmentState(this.authId, attachment.client_attachment_id, 'uploading');
    await markMediaUploadSessionState(
      this.authId,
      attachment.client_attachment_id,
      session.variant,
      'uploading',
    );
    const unsignedPartNumbers = parts
      .filter(
        (part) =>
          part.state !== 'uploaded' && (!part.signed_url || isExpired(part.signed_url_expires_at)),
      )
      .map((part) => part.part_number);
    if (unsignedPartNumbers.length > 0 && session.upload_session_id) {
      const signed = await signMediaUploadParts(
        this.pb,
        session.upload_session_id,
        unsignedPartNumbers,
      );
      await this.persistMediaUploadSessionResponse(attachment, signed);
    }
    const refreshedParts = await listMediaUploadPartsForSession(
      this.authId,
      session.client_attachment_id,
      session.variant,
    );

    for (const part of refreshedParts) {
      if (part.state === 'uploaded') {
        continue;
      }
      await this.uploadMediaPart(attachment, session, part);
    }
    await markMediaAttachmentState(this.authId, attachment.client_attachment_id, 'uploaded');
    await markMediaUploadSessionState(
      this.authId,
      attachment.client_attachment_id,
      session.variant,
      'uploaded',
    );
  }

  private async uploadMediaPart(
    attachment: LocalMediaOutboxAttachment,
    session: LocalMediaUploadSession,
    part: LocalMediaUploadPart,
  ) {
    let signedPart = part;
    if (
      (!signedPart.signed_url || isExpired(signedPart.signed_url_expires_at)) &&
      session.upload_session_id
    ) {
      const signed = await signMediaUploadParts(this.pb, session.upload_session_id, [
        part.part_number,
      ]);
      await this.persistMediaUploadSessionResponse(attachment, signed);
      const parts = await listMediaUploadPartsForSession(
        this.authId,
        session.client_attachment_id,
        session.variant,
      );
      signedPart = parts.find((candidate) => candidate.part_number === part.part_number) ?? part;
    }
    if (!signedPart.signed_url) {
      throw new Error('Multipart upload part is missing a presigned URL.');
    }

    await markMediaUploadPartState(
      this.authId,
      session.client_attachment_id,
      session.variant,
      part.part_number,
      'uploading',
    );
    const result = await InfchatMediaTransfer.uploadFilePartAsync({
      fileUri: attachment.local_uri,
      headers: parseHeaderJSON(signedPart.signed_url_headers_json),
      length: signedPart.byte_size,
      method: signedPart.signed_url_method ?? 'PUT',
      offset: signedPart.offset_bytes,
      url: signedPart.signed_url,
    });
    assertSuccessfulUpload(result.status);
    const etag = normalizeETag(result.etag || headerValue(result.headers, 'etag'));
    if (!etag) {
      throw new Error('Multipart upload part did not return an ETag.');
    }
    await markMediaUploadPartState(
      this.authId,
      session.client_attachment_id,
      session.variant,
      part.part_number,
      'uploaded',
      etag,
    );
  }

  private async completeMediaSession(
    attachment: LocalMediaOutboxAttachment,
    session: LocalMediaUploadSession,
  ) {
    if (!session.upload_session_id) {
      throw new Error('Media upload session is missing its server id.');
    }
    await markMediaUploadSessionState(
      this.authId,
      attachment.client_attachment_id,
      session.variant,
      'completing',
    );
    const parts =
      session.upload_mode === 'multipart' ? await completedUploadParts(this.authId, session) : [];
    const response = await completeMediaUpload(this.pb, session.upload_session_id, parts);
    await this.persistMediaUploadSessionResponse(attachment, response);
    if (response.session.state !== 'completed') {
      throw new Error('Media upload session did not complete.');
    }
  }

  private async finalizeMediaOutboxMessage(
    message: LocalMediaOutboxMessageWithAttachments,
    deviceId: string,
  ) {
    const completedSessions = await listCompletedMediaUploadSessionsForMessage(
      this.authId,
      message.client_message_id,
    );
    if (completedSessions.length !== message.attachments.length) {
      throw new Error('Completed media upload sessions are incomplete.');
    }
    const sessionByAttachmentId = new Map(
      completedSessions.map((session) => [session.client_attachment_id, session]),
    );
    const attachments = message.attachments.map((attachment) => {
      const session = sessionByAttachmentId.get(attachment.client_attachment_id);
      if (!session) {
        throw new Error('Completed upload session was not found for attachment.');
      }

      return {
        clientAttachmentId: attachment.client_attachment_id,
        uploadSessionId: session.upload_session_id,
      };
    });

    await markMediaOutboxState(this.authId, message.client_message_id, 'sending_create');
    const response = await sendMediaMessageCommand(this.pb, {
      attachments,
      body: message.body,
      clientMessageId: message.client_message_id,
      conversationId: message.conversation_id,
      deviceId,
      kind: message.kind,
    });
    await applyLocalChatRecords(this.authId, {
      attachmentVariants: response.attachmentVariants,
      attachments: response.attachments,
      conversation: response.conversation,
      membership: response.membership,
      message: response.message,
    });
    void logDebugEvent('info', 'media-outbox', 'Media outbox message sent', {
      clientMessageId: message.client_message_id,
      serverMessageId: response.message.id,
    });
    this.enqueueSync('outbox');
  }

  private async persistMediaUploadSessionResponse(
    attachment: LocalMediaOutboxAttachment,
    response: MediaUploadSessionResponse,
  ) {
    const session = response.session;
    const state = toLocalSessionState(session.state);
    await upsertMediaUploadSession(this.authId, {
      attachmentId: response.attachmentId || session.attachment_id,
      attachmentKind: session.attachment_kind,
      blurhash: session.blurhash || attachment.blurhash || null,
      byteSize: session.byte_size,
      clientAttachmentId: session.client_attachment_id,
      clientMessageId: session.client_message_id,
      completedAt: session.completed_at ?? null,
      conversationId: session.conversation,
      durationMs: session.duration_ms ?? null,
      expiresAt: session.expires_at ?? null,
      height: session.height ?? null,
      lastError: session.last_error ?? null,
      localUri: attachment.local_uri,
      mimeType: session.mime_type,
      objectKey: response.objectKey || session.object_key,
      originalName: session.original_name || attachment.original_name,
      partCount: session.part_count ?? null,
      partSize: session.part_size ?? null,
      presignedExpiresAt: response.presigned
        ? new Date(Date.now() + response.presigned.expires * 1000).toISOString()
        : null,
      presignedHeadersJson: response.presigned ? JSON.stringify(response.presigned.headers) : null,
      presignedMethod: response.presigned?.method ?? null,
      presignedUrl: response.presigned?.url ?? null,
      profileJson: JSON.stringify(response.profile),
      sha256: session.sha256 || attachment.sha256 || null,
      state,
      storageProfileId: session.storage_profile ?? response.profile.id,
      uploadId: response.uploadId || session.upload_id || null,
      uploadMode: session.upload_mode,
      uploadSessionId: session.id,
      variant: session.variant,
      width: session.width ?? null,
    });

    if (session.upload_mode === 'multipart') {
      const parts = response.parts ?? [];
      const unsignedPartNumbers = parts
        .filter((part) => !part.presigned && part.state !== 'uploaded')
        .map((part) => part.partNumber);
      const partsResponse =
        unsignedPartNumbers.length > 0
          ? await signMediaUploadParts(this.pb, session.id, unsignedPartNumbers)
          : response;
      for (const part of partsResponse.parts ?? response.parts ?? []) {
        await upsertMediaUploadPart(this.authId, {
          byteSize: part.byteSize,
          clientAttachmentId: session.client_attachment_id,
          clientMessageId: session.client_message_id,
          etag: part.etag ?? null,
          offsetBytes: part.offsetBytes,
          partNumber: part.partNumber,
          signedUrl: part.presigned?.url ?? null,
          signedUrlExpiresAt:
            part.signedUrlExpiresAt ||
            (part.presigned
              ? new Date(Date.now() + part.presigned.expires * 1000).toISOString()
              : null),
          signedUrlHeadersJson: part.presigned ? JSON.stringify(part.presigned.headers) : null,
          signedUrlMethod: part.presigned?.method ?? null,
          state: toLocalPartState(part.state),
          uploadSessionId: session.id,
          variant: session.variant,
        });
      }
    }
  }

  private scheduleOutboxRetry(delayMs: number) {
    if (this.outboxRetryTimer) {
      return;
    }

    void logDebugEvent('debug', 'outbox', 'Scheduled outbox pump retry', {
      delayMs,
    });
    this.outboxRetryTimer = setTimeout(() => {
      this.outboxRetryTimer = null;
      void this.pumpOutbox();
    }, delayMs);
  }

  private invalidateChatQueries(conversationId?: string) {
    void this.queryClient.invalidateQueries({
      queryKey: ['chat', this.authId],
    });
    if (conversationId) {
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'conversation', conversationId],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'messages', conversationId],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'outbox', conversationId],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'media-outbox', conversationId],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'memberships'],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'memberships', conversationId],
      });
    }
  }
}

function isPermanentCommandError(error: unknown) {
  const status = getErrorStatus(error);

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function toLocalSessionState(state: string): LocalMediaUploadSessionState {
  switch (state) {
    case 'pending':
    case 'uploading':
    case 'uploaded':
    case 'completing':
    case 'completed':
    case 'failed':
    case 'aborted':
    case 'expired':
      return state;
    default:
      return 'pending';
  }
}

function toLocalPartState(state: string) {
  switch (state) {
    case 'signed':
    case 'uploaded':
    case 'failed':
      return state;
    default:
      return 'pending';
  }
}

function isUploadSessionReadyForTransfer(state: LocalMediaUploadSessionState) {
  return (
    state === 'pending' || state === 'uploading' || state === 'uploaded' || state === 'completed'
  );
}

async function completedUploadParts(
  authId: string,
  session: LocalMediaUploadSession,
): Promise<CompleteMediaUploadPartInput[]> {
  const parts = await listMediaUploadPartsForSession(
    authId,
    session.client_attachment_id,
    session.variant,
  );
  const completedParts = parts
    .map((part): CompleteMediaUploadPartInput | null => {
      const etag = normalizeETag(part.etag);
      if (!etag) {
        return null;
      }

      return {
        etag,
        partNumber: part.part_number,
      };
    })
    .filter((part): part is CompleteMediaUploadPartInput => !!part);

  if (completedParts.length !== parts.length) {
    throw new Error('Multipart upload parts are incomplete.');
  }

  return completedParts;
}

function parseHeaderJSON(value?: string | null): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function assertSuccessfulUpload(status: number) {
  if (status < 200 || status >= 300) {
    throw new Error(`Media upload failed with HTTP ${status}.`);
  }
}

function isExpired(value?: string | null) {
  if (!value) {
    return true;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return true;
  }

  return time <= Date.now() + 30_000;
}

function headerValue(headers: Record<string, string>, name: string) {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());

  return match?.[1];
}

function normalizeETag(value?: string | null) {
  return value?.trim().replace(/^"|"$/g, '') ?? '';
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') {
    return 0;
  }

  for (const key of ['status', 'statusCode', 'code']) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') {
      return value;
    }
  }

  const response = (error as { response?: unknown }).response;
  if (response && typeof response === 'object') {
    const code = (response as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }

  return 0;
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return 'Unknown error';
}
