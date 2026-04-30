import { createContext, useContext } from 'react';

import type { ChatSyncService } from './chat-sync-service';

export const ChatSyncContext = createContext<ChatSyncService | null>(null);

export function useChatSyncService() {
  const value = useContext(ChatSyncContext);

  if (!value) {
    throw new Error('useChatSyncService must be used inside ChatSyncContext');
  }

  return value;
}
