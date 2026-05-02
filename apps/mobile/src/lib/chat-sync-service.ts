import {
  bootstrapChatSync,
  type ConversationMembershipRecord,
  type ConversationRecord,
  deleteConversationMessages,
  getMediaUploadStatus,
  listConversationMessagesBeforeSeq,
  markConversationReadBySeq,
  type MediaUploadSessionResponse,
  sendTextMessageCommand,
  signMediaUploadParts,
  startMediaUpload,
  syncChatEvents,
} from '@infchat/pocketbase';
import type { QueryClient } from '@tanstack/react-query';
import type PocketBase from 'pocketbase';

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
  type LocalMediaUploadSessionState,
  listMediaUploadSessionsForMessage,
  listPendingMediaOutboxMessages,
  listPendingOutboxMessages,
  markMediaAttachmentState,
  markMediaOutboxRetry,
  markMediaOutboxState,
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
    await applyConversationHistory(this.authId, response.messages);
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
          await this.prepareMediaUploadSessions(pendingMessage);
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
