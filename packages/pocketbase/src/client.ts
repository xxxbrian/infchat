import PocketBase from 'pocketbase';

export type CreatePocketBaseClientOptions = {
  baseUrl: string;
};

export function createPocketBaseClient(options: CreatePocketBaseClientOptions): PocketBase {
  return new PocketBase(options.baseUrl);
}
