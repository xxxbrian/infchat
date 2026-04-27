import { createPocketBaseClient } from '@infchat/pocketbase';
import * as SecureStore from 'expo-secure-store';
import { AsyncAuthStore } from 'pocketbase';

const AUTH_STORAGE_KEY = 'infchat:pocketbase:auth';

const authStore = new AsyncAuthStore({
  initial: SecureStore.getItemAsync(AUTH_STORAGE_KEY),
  save: async (serialized) => {
    if (serialized) {
      await SecureStore.setItemAsync(AUTH_STORAGE_KEY, serialized);
    } else {
      await SecureStore.deleteItemAsync(AUTH_STORAGE_KEY);
    }
  },
});

export const pocketBaseUrl = process.env.EXPO_PUBLIC_POCKETBASE_URL ?? 'http://127.0.0.1:8090';

export const pb = createPocketBaseClient({
  baseUrl: pocketBaseUrl,
  authStore,
});
