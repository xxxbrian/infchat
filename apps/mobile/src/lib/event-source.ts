import EventSource from 'react-native-sse';

const globalScope = globalThis as unknown as { EventSource?: unknown };

// PocketBase realtime expects a browser-compatible EventSource global.
// React Native does not provide one, so install the SSE polyfill before pb is used.
if (!globalScope.EventSource) {
  globalScope.EventSource = EventSource;
}
