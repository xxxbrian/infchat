import PocketBase, { type BaseAuthStore } from 'pocketbase';

export type CreatePocketBaseClientOptions = {
  baseUrl: string;
  authStore?: BaseAuthStore;
};

export function createPocketBaseClient(options: CreatePocketBaseClientOptions): PocketBase {
  return new PocketBase(options.baseUrl, options.authStore);
}
