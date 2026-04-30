import {
  bootstrapChatSync,
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
  enqueueTextOutboxMessage,
  getChatSyncCursor,
  listPendingOutboxMessages,
  markOutboxRetry,
  markOutboxSending,
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

type ChatSyncServiceOptions = {
  authId: string;
  pb: PocketBase;
  queryClient: QueryClient;
};

export class ChatSyncService {
  private authId: string;
  private isOutboxRunning = false;
  private isSyncRunning = false;
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

  enqueueSync(trigger: ChatSyncTrigger) {
    this.pendingTriggers.add(trigger);
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
        this.invalidateChatQueries();
        return;
      }

      let cursor = fromCursor;
      let hasMore = true;
      while (hasMore) {
        const response = await syncChatEvents(this.pb, cursor);
        await applyChatSyncEvents(this.authId, response.events, response.cursor);
        cursor = response.cursor;
        hasMore = response.hasMore;
      }

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
          await markOutboxRetry(
            this.authId,
            pendingMessage.client_message_id,
            getErrorMessage(error),
          );
        }
        this.invalidateChatQueries(pendingMessage.conversation_id);
      }
    } finally {
      this.isOutboxRunning = false;
    }
  }

  private invalidateChatQueries(conversationId?: string) {
    void this.queryClient.invalidateQueries({
      queryKey: ['chat', this.authId],
    });
    if (conversationId) {
      void this.queryClient.invalidateQueries({
        queryKey: ['chat', this.authId, 'messages', conversationId],
      });
    }
  }
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
