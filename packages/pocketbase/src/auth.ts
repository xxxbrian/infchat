import { normalizeUsername } from '@infchat/shared';
import type PocketBase from 'pocketbase';

export type UsernameAuthInput = {
  username: string;
  password: string;
};

export async function registerWithUsername(pb: PocketBase, input: UsernameAuthInput) {
  const username = normalizeUsername(input.username);

  await pb.collection('users').create({
    username,
    password: input.password,
    passwordConfirm: input.password,
  });

  return signInWithUsername(pb, { username, password: input.password });
}

export function signInWithUsername(pb: PocketBase, input: UsernameAuthInput) {
  return pb.collection('users').authWithPassword(normalizeUsername(input.username), input.password);
}

export function signOut(pb: PocketBase): void {
  pb.authStore.clear();
}
