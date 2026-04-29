import type { CallRoomRecord } from '@infchat/pocketbase';
import { useEffect, useState } from 'react';

const RINGING_TIMEOUT_MS = 45_000;

export function useRingingSecondsLeft(callRoom: CallRoomRecord | null | undefined): number | null {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (callRoom?.status !== 'ringing') {
      return;
    }

    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);

    return () => clearInterval(interval);
  }, [callRoom?.created, callRoom?.status]);

  if (callRoom?.status !== 'ringing') {
    return null;
  }

  const createdMs = Date.parse(callRoom.created);
  if (!Number.isFinite(createdMs)) {
    return null;
  }

  return Math.max(0, Math.ceil((createdMs + RINGING_TIMEOUT_MS - nowMs) / 1000));
}
