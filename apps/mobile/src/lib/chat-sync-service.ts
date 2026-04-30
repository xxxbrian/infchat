import {
  bootstrapChatSync,
  type ConversationRecord,
  deleteConversationMessages,
  listConversationMessagesBeforeSeq,
  markConversationReadBySeq,
  sendTextMessageCommand,
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
  enqueueTextOutboxMessage,
  getChatSyncCursor,
  listPendingOutboxMessages,
  markOutboxRetry,
  markOutboxSending,
  markOutboxTerminalFailure,
  removeLocalMessages,
  resetOutboxMessageForRetry,
  writeSyncJournal,
} from './chat-sync-store';
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
    this.enqueueSync('startup');
    this.pumpOutbox();
  }

  dispose() {
    if (this.outboxRetryTimer) {
      clearTimeout(this.outboxRetryTimer);
      this.outboxRetryTimer = null;
    }
  }

  enqueueSync(trigger: ChatSyncTrigger) {
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
    this.invalidateChatQueries(conversationId);
    void this.pumpOutbox();

    return message;
  }

  async retryOutboxMessage(conversationId: string, clientMessageId: string) {
    await resetOutboxMessageForRetry(this.authId, clientMessageId);
    this.invalidateChatQueries(conversationId);
    await this.pumpOutbox();
  }

  async cancelFailedOutboxMessage(conversationId: string, clientMessageId: string) {
    await cancelOutboxMessage(this.authId, clientMessageId);
    this.invalidateChatQueries(conversationId);
  }

  async deleteMessages(conversationId: string, messageIds: string[]) {
    if (messageIds.length === 0) {
      return;
    }

    const response = await deleteConversationMessages(this.pb, conversationId, messageIds);
    const deletedMessageIds = response.messages.map((message) => message.id);
    await applyLocalChatRecords(this.authId, {
      conversation: response.conversation,
    });
    await removeLocalMessages(this.authId, deletedMessageIds);
    this.invalidateChatQueries(conversationId);
    this.enqueueSync('manual');
  }

  async applyConversationSnapshot(conversation: ConversationRecord) {
    await applyLocalChatRecords(this.authId, { conversation });
    this.invalidateChatQueries(conversation.id);
  }

  async syncConversationHistory(conversationId: string, beforeSeq?: number) {
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
    const response = await markConversationReadBySeq(this.pb, conversationId, lastReadSeq);
    await applyLocalChatRecords(this.authId, { state: response.state });
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
    try {
      if (fromCursor === 0) {
        const bootstrap = await bootstrapChatSync(this.pb);
        await applyChatBootstrap(
          this.authId,
          bootstrap.conversations,
          bootstrap.states,
          bootstrap.cursor,
        );
        await writeSyncJournal(this.authId, trigger, 'success', fromCursor, bootstrap.cursor);
        await this.syncFromCursor(bootstrap.cursor);
        this.invalidateChatQueries();
        return;
      }

      const cursor = await this.syncFromCursor(fromCursor);

      await writeSyncJournal(this.authId, trigger, 'success', fromCursor, cursor);
      this.invalidateChatQueries();
    } catch (error) {
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
      for (const pendingMessage of pendingMessages) {
        await markOutboxSending(this.authId, pendingMessage.client_message_id);
        this.invalidateChatQueries(pendingMessage.conversation_id);
        try {
          const response = await sendTextMessageCommand(this.pb, {
            body: pendingMessage.body,
            clientMessageId: pendingMessage.client_message_id,
            conversationId: pendingMessage.conversation_id,
            deviceId,
          });
          await applyLocalChatRecords(this.authId, {
            conversation: response.conversation,
            message: response.message,
          });
          this.enqueueSync('outbox');
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          const attemptCount = pendingMessage.attempt_count ?? 0;
          const retryDelayMs = OUTBOX_RETRY_DELAYS_MS[attemptCount];
          if (isPermanentCommandError(error) || retryDelayMs === undefined) {
            await markOutboxTerminalFailure(
              this.authId,
              pendingMessage.client_message_id,
              errorMessage,
            );
          } else {
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

  private scheduleOutboxRetry(delayMs: number) {
    if (this.outboxRetryTimer) {
      return;
    }

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
        queryKey: ['chat', this.authId, 'conversation-states'],
      });
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'conversation-states', conversationId],
      });
    }
  }
}

function isPermanentCommandError(error: unknown) {
  const status = getErrorStatus(error);

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
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
