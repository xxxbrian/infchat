import Ionicons from '@expo/vector-icons/Ionicons';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
  const [searchQuery, setSearchQuery] = useState('');
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
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
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
  searchQuery,
  setSearchQuery,
  statusMessage,
}: {
  logs: DebugLogEntry[];
  onClear: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  onShare: () => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  statusMessage: string | null;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const visibleLogs = useMemo(() => {
    const orderedLogs = [...logs].reverse();
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return orderedLogs;
    }

    return orderedLogs.filter((log) =>
      formatTerminalLogLine(log).toLowerCase().includes(normalizedQuery),
    );
  }, [logs, searchQuery]);
  const terminalText = visibleLogs.map(formatTerminalLogLine).join('\n');

  return (
    <View className="mt-5">
      <View className="mb-2 flex-row items-center justify-between px-2">
        <Text className="text-xs font-bold uppercase tracking-[0.8px] text-muted-foreground">
          Logs ({visibleLogs.length}/{logs.length})
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

      <View className="mb-3 flex-row items-center gap-2 rounded-2xl bg-muted px-4 py-2">
        <Ionicons color="#64748b" name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-9 flex-1 py-0 font-mono text-sm text-foreground"
          onChangeText={setSearchQuery}
          placeholder="Filter logs"
          placeholderTextColor="#64748b"
          value={searchQuery}
        />
        {searchQuery.length > 0 ? (
          <Pressable
            className="h-8 w-8 items-center justify-center"
            onPress={() => setSearchQuery('')}
          >
            <Ionicons color="#94a3b8" name="close-circle" size={18} />
          </Pressable>
        ) : null}
      </View>

      <View
        className="overflow-hidden rounded-[18px] border border-border/70 bg-[#05070c]"
        style={styles.terminal}
      >
        {logs.length === 0 ? (
          <View className="flex-1 justify-center px-4">
            <Text className="font-mono text-xs text-muted-foreground">No debug logs yet.</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerStyle={styles.terminalContent}
            nestedScrollEnabled
            onContentSizeChange={() => {
              scrollRef.current?.scrollToEnd({ animated: false });
            }}
            showsVerticalScrollIndicator
          >
            {terminalText.length > 0 ? (
              <Text className="font-mono text-[11px] leading-4 text-slate-300" selectable>
                {terminalText}
              </Text>
            ) : (
              <Text className="font-mono text-xs text-muted-foreground">
                No logs match this filter.
              </Text>
            )}
          </ScrollView>
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

function formatTerminalLogLine(log: DebugLogEntry) {
  const details = log.details ? ` ${compactLogText(log.details)}` : '';
  return `${formatLogTime(log.created_at)} ${log.level.toUpperCase().padEnd(5)} [${log.scope}] ${compactLogText(log.message)}${details}`;
}

function compactLogText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function formatLogTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().replace('T', ' ').replace('Z', '');
}

const styles = StyleSheet.create({
  group: {
    borderCurve: 'continuous',
  } as ViewStyle,
  terminal: {
    borderCurve: 'continuous',
    height: 420,
  } as ViewStyle,
  terminalContent: {
    minWidth: '100%',
    padding: 12,
  },
});
