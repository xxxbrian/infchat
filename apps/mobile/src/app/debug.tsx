import Ionicons from '@expo/vector-icons/Ionicons';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../lib/auth-context';
import {
  clearDebugLogs,
  formatDebugLogs,
  listDebugLogs,
  logDebugEvent,
  type DebugLogEntry,
} from '../lib/debug-log';
import { getDeviceId } from '../lib/device-id';
import { pb, pocketBaseUrl } from '../lib/pocketbase';

type DebugItem = {
  label: string;
  value: string;
};

const NOT_SET = '(not set)';

export default function DebugScreen() {
  const insets = useSafeAreaInsets();
  const { authRecord } = useAuth();
  const [deviceId, setDeviceId] = useState<string>(NOT_SET);
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [networkState, setNetworkState] = useState<NetInfoState | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const extra = Constants.expoConfig?.extra ?? {};

  useEffect(() => {
    let isMounted = true;

    getDeviceId()
      .then((nextDeviceId) => {
        if (isMounted) {
          setDeviceId(nextDeviceId);
        }
      })
      .catch(() => {
        if (isMounted) {
          setDeviceId('(unavailable)');
        }
      });

    const unsubscribe = NetInfo.addEventListener((state) => {
      setNetworkState(state);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void refreshLogs();
  }, []);

  const refreshLogs = async () => {
    const nextLogs = await listDebugLogs(300);
    setLogs(nextLogs);
  };

  const copyLogs = async () => {
    const text = logs.length > 0 ? formatDebugLogs(logs) : 'No debug logs.';
    await Clipboard.setStringAsync(text);
    setStatusMessage(`Copied ${logs.length} log entries`);
    void logDebugEvent('info', 'debug-screen', 'Copied debug logs', {
      count: logs.length,
    });
  };

  const shareLogs = async () => {
    const text = logs.length > 0 ? formatDebugLogs(logs) : 'No debug logs.';
    const fileUri = `${FileSystem.cacheDirectory ?? ''}infchat-debug-${Date.now()}.log`;
    await FileSystem.writeAsStringAsync(fileUri, text, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri, {
        dialogTitle: 'Share InfChat debug logs',
        mimeType: 'text/plain',
        UTI: 'public.plain-text',
      });
      void logDebugEvent('info', 'debug-screen', 'Shared debug logs', {
        count: logs.length,
      });
    } else {
      await Clipboard.setStringAsync(text);
      setStatusMessage('Sharing unavailable; copied logs instead');
    }
  };

  const confirmClearLogs = () => {
    Alert.alert('Clear debug logs?', 'This removes local logs stored on this device.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => {
          void clearLogs();
        },
        style: 'destructive',
        text: 'Clear',
      },
    ]);
  };

  const clearLogs = async () => {
    await clearDebugLogs();
    await refreshLogs();
    setStatusMessage('Cleared debug logs');
  };

  const envItems: DebugItem[] = [
    {
      label: 'EXPO_PUBLIC_POCKETBASE_URL',
      value: process.env.EXPO_PUBLIC_POCKETBASE_URL ?? NOT_SET,
    },
    {
      label: 'EXPO_PUBLIC_LIVEKIT_URL',
      value: process.env.EXPO_PUBLIC_LIVEKIT_URL ?? NOT_SET,
    },
    { label: 'PocketBase client URL', value: pocketBaseUrl },
    {
      label: 'Expo extra pocketbaseUrl',
      value: stringValue(extra.pocketbaseUrl),
    },
    { label: 'Expo extra livekitUrl', value: stringValue(extra.livekitUrl) },
  ];

  const appItems: DebugItem[] = [
    { label: 'App name', value: Constants.expoConfig?.name ?? NOT_SET },
    { label: 'Slug', value: Constants.expoConfig?.slug ?? NOT_SET },
    { label: 'Version', value: Constants.expoConfig?.version ?? NOT_SET },
    {
      label: 'SDK version',
      value: Constants.expoConfig?.sdkVersion ?? NOT_SET,
    },
    { label: 'Scheme', value: stringValue(Constants.expoConfig?.scheme) },
    {
      label: 'Bundle ID',
      value: Constants.expoConfig?.ios?.bundleIdentifier ?? NOT_SET,
    },
    {
      label: 'Android package',
      value: Constants.expoConfig?.android?.package ?? NOT_SET,
    },
  ];

  const runtimeItems: DebugItem[] = [
    { label: 'Platform', value: Platform.OS },
    { label: 'Platform version', value: String(Platform.Version) },
    { label: 'Device ID', value: deviceId },
    { label: 'Session ID', value: Constants.sessionId ?? NOT_SET },
    { label: 'PocketBase auth valid', value: String(pb.authStore.isValid) },
    { label: 'Auth user ID', value: authRecord.id },
    { label: 'Auth username', value: authRecord.username || NOT_SET },
  ];

  const networkItems: DebugItem[] = [
    { label: 'Network type', value: networkState?.type ?? NOT_SET },
    { label: 'Connected', value: booleanValue(networkState?.isConnected) },
    {
      label: 'Internet reachable',
      value: booleanValue(networkState?.isInternetReachable),
    },
  ];

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center justify-between border-b border-border/60 px-5 pb-3"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable className="h-10 w-16 justify-center" onPress={router.back}>
          <Ionicons color="#94a3b8" name="chevron-back" size={26} />
        </Pressable>
        <Text className="text-lg font-bold text-foreground">Debug</Text>
        <View className="w-16" />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-5 pb-5 pt-5">
          <Text className="px-2 text-sm font-medium leading-5 text-muted-foreground">
            Runtime-only diagnostics for validating release builds and backend configuration.
          </Text>

          <DebugSection items={envItems} title="Environment" />
          <DebugSection items={appItems} title="App" />
          <DebugSection items={runtimeItems} title="Runtime" />
          <DebugSection items={networkItems} title="Network" />
          <DebugLogSection
            logs={logs}
            onClear={confirmClearLogs}
            onCopy={copyLogs}
            onRefresh={refreshLogs}
            onShare={shareLogs}
            statusMessage={statusMessage}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function DebugLogSection({
  logs,
  onClear,
  onCopy,
  onRefresh,
  onShare,
  statusMessage,
}: {
  logs: DebugLogEntry[];
  onClear: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  onShare: () => void;
  statusMessage: string | null;
}) {
  return (
    <View className="mt-5">
      <View className="mb-2 flex-row items-center justify-between px-2">
        <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
          Logs ({logs.length})
        </Text>
        {statusMessage ? (
          <Text className="text-xs font-semibold text-blue-300">{statusMessage}</Text>
        ) : null}
      </View>

      <View className="mb-3 flex-row flex-wrap gap-2 px-2">
        <DebugActionButton icon="refresh" label="Refresh" onPress={onRefresh} />
        <DebugActionButton icon="copy-outline" label="Copy" onPress={onCopy} />
        <DebugActionButton icon="share-outline" label="Share" onPress={onShare} />
        <DebugActionButton destructive icon="trash-outline" label="Clear" onPress={onClear} />
      </View>

      <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
        {logs.length === 0 ? (
          <View className="px-5 py-5">
            <Text className="text-sm font-semibold text-muted-foreground">No debug logs yet.</Text>
          </View>
        ) : (
          logs.map((log, index) => (
            <View className="px-5" key={log.id}>
              <View
                className={`py-4 ${index < logs.length - 1 ? 'border-b border-border/70' : ''}`}
              >
                <View className="mb-2 flex-row items-center gap-2">
                  <Text className={`text-xs font-black uppercase ${levelClassName(log.level)}`}>
                    {log.level}
                  </Text>
                  <Text className="text-xs font-semibold text-muted-foreground">[{log.scope}]</Text>
                  <Text className="ml-auto text-[11px] font-medium text-muted-foreground">
                    {formatLogTime(log.created_at)}
                  </Text>
                </View>
                <Text className="text-sm font-semibold leading-5 text-foreground" selectable>
                  {log.message}
                </Text>
                {log.details ? (
                  <Text
                    className="mt-2 rounded-2xl bg-background/70 p-3 font-mono text-xs leading-5 text-muted-foreground"
                    selectable
                  >
                    {log.details}
                  </Text>
                ) : null}
              </View>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function DebugActionButton({
  destructive,
  icon,
  label,
  onPress,
}: {
  destructive?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      className={`flex-row items-center gap-2 rounded-full px-4 py-2 ${destructive ? 'bg-red-500/15' : 'bg-muted'}`}
      onPress={onPress}
    >
      <Ionicons color={destructive ? '#fb7185' : '#cbd5e1'} name={icon} size={16} />
      <Text className={`text-sm font-bold ${destructive ? 'text-red-300' : 'text-foreground'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function DebugSection({ items, title }: { items: DebugItem[]; title: string }) {
  return (
    <View className="mt-5">
      <Text className="mb-2 px-2 text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
        {title}
      </Text>
      <View className="overflow-hidden rounded-[28px] bg-muted" style={styles.group}>
        {items.map((item, index) => (
          <View className="px-5" key={item.label}>
            <View className={`py-4 ${index < items.length - 1 ? 'border-b border-border/70' : ''}`}>
              <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
                {item.label}
              </Text>
              <Text className="mt-2 text-[16px] font-semibold leading-6 text-foreground" selectable>
                {item.value}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function booleanValue(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return NOT_SET;
  }

  return String(value);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return NOT_SET;
}

function levelClassName(level: DebugLogEntry['level']) {
  switch (level) {
    case 'error':
      return 'text-red-300';
    case 'warn':
      return 'text-amber-300';
    case 'debug':
      return 'text-slate-400';
    default:
      return 'text-blue-300';
  }
}

function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  } as ViewStyle,
});
