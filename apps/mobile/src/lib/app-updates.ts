import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import InfchatMediaTransfer from '../../modules/infchat-media-transfer';

export type AppUpdateChannel = 'beta' | 'stable';

export type AppUpdateRelease = {
  apkUrl: string;
  byteSize: number;
  channel: AppUpdateChannel;
  fileName: string;
  forceUpdateBelowVersionCode: number | null;
  minSupportedVersionCode: number;
  publishedAt: string;
  releaseNotes: string;
  sha256: string;
  url: string;
  versionCode: number;
  versionName: string;
};

export type AppUpdateCheckResult = {
  currentVersionCode: number;
  isAvailable: boolean;
  isForced: boolean;
  release: AppUpdateRelease | null;
};

const UPDATE_CHANNEL_STORAGE_KEY = 'infchat.android.update.channel';
const UPDATE_CHECKED_AT_STORAGE_KEY = 'infchat.android.update.checkedAt';
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DOWNLOADS_BASE_URL =
  process.env.EXPO_PUBLIC_INFCHAT_DOWNLOADS_BASE_URL ||
  stringExtra(Constants.expoConfig?.extra?.downloadsBaseUrl);
const DEFAULT_CHANNEL =
  normalizeUpdateChannel(process.env.EXPO_PUBLIC_INFCHAT_UPDATE_CHANNEL) ?? 'beta';

export function isAndroidAppUpdatesSupported() {
  return Platform.OS === 'android' && Boolean(DOWNLOADS_BASE_URL);
}

export async function getSelectedAppUpdateChannel(): Promise<AppUpdateChannel> {
  if (Platform.OS !== 'android') {
    return DEFAULT_CHANNEL;
  }

  const stored = await SecureStore.getItemAsync(UPDATE_CHANNEL_STORAGE_KEY);
  return normalizeUpdateChannel(stored) ?? DEFAULT_CHANNEL;
}

export async function setSelectedAppUpdateChannel(channel: AppUpdateChannel) {
  await SecureStore.setItemAsync(UPDATE_CHANNEL_STORAGE_KEY, channel);
}

export async function shouldAutoCheckAppUpdate(intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS) {
  if (!isAndroidAppUpdatesSupported()) {
    return false;
  }
  const checkedAt = Number(await SecureStore.getItemAsync(UPDATE_CHECKED_AT_STORAGE_KEY));
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) {
    return true;
  }

  return Date.now() - checkedAt >= intervalMs;
}

export async function markAppUpdateChecked() {
  await SecureStore.setItemAsync(UPDATE_CHECKED_AT_STORAGE_KEY, String(Date.now()));
}

export async function checkForAppUpdate(channel?: AppUpdateChannel): Promise<AppUpdateCheckResult> {
  if (!isAndroidAppUpdatesSupported()) {
    return {
      currentVersionCode: 0,
      isAvailable: false,
      isForced: false,
      release: null,
    };
  }

  const selectedChannel = channel ?? (await getSelectedAppUpdateChannel());
  const currentVersionCode = await InfchatMediaTransfer.getNativeVersionCodeAsync();
  const release = await fetchChannelRelease(selectedChannel);
  const isAvailable = release.versionCode > currentVersionCode;
  const forceBelow = release.forceUpdateBelowVersionCode;
  const isForced = typeof forceBelow === 'number' && currentVersionCode < forceBelow;

  await markAppUpdateChecked();

  return {
    currentVersionCode,
    isAvailable,
    isForced,
    release: isAvailable || isForced ? release : null,
  };
}

export async function downloadAndInstallAppUpdate(release: AppUpdateRelease): Promise<string> {
  if (Platform.OS !== 'android') {
    throw new Error('APK updates are only available on Android.');
  }
  const canInstall = await InfchatMediaTransfer.canInstallUnknownAppsAsync();
  if (!canInstall) {
    await InfchatMediaTransfer.openInstallUnknownAppsSettingsAsync();
    throw new Error('Allow InfChat to install unknown apps, then try again.');
  }

  const downloadsDir = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ''}updates/`;
  await FileSystem.makeDirectoryAsync(downloadsDir, {
    intermediates: true,
  }).catch(() => {});
  const fileUri = `${downloadsDir}${safeFileName(release.fileName || `InfChat-${release.versionCode}.apk`)}`;
  const download = await FileSystem.downloadAsync(release.apkUrl || release.url, fileUri);
  if (download.status < 200 || download.status >= 300) {
    throw new Error(`APK download failed with HTTP ${download.status}.`);
  }

  const sha256 = await InfchatMediaTransfer.sha256FileAsync(download.uri);
  if (release.sha256 && sha256.toLowerCase() !== release.sha256.toLowerCase()) {
    throw new Error('Downloaded APK failed integrity verification.');
  }

  await InfchatMediaTransfer.installApkAsync(download.uri);

  return download.uri;
}

export function formatAppUpdateChannel(channel: AppUpdateChannel) {
  return channel === 'beta' ? 'Beta' : 'Stable';
}

function channelReleaseUrl(channel: AppUpdateChannel) {
  const baseUrl = DOWNLOADS_BASE_URL.replace(/\/+$/, '');
  const path = `infchat/releases/android/channels/${channel}.json`;

  return `${baseUrl}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function fetchChannelRelease(channel: AppUpdateChannel): Promise<AppUpdateRelease> {
  const response = await fetch(`${channelReleaseUrl(channel)}?t=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Could not check ${formatAppUpdateChannel(channel)} updates.`);
  }

  return normalizeRelease(await response.json(), channel);
}

function normalizeRelease(value: unknown, fallbackChannel: AppUpdateChannel): AppUpdateRelease {
  if (!value || typeof value !== 'object') {
    throw new Error('Update metadata is invalid.');
  }
  const record = value as Record<string, unknown>;
  const versionCode = numberValue(record.versionCode);
  const versionName = stringValue(record.versionName);
  const url = stringValue(record.apkUrl) || stringValue(record.url);
  const sha256 = stringValue(record.sha256);
  if (!versionCode || !versionName || !url || !sha256) {
    throw new Error('Update metadata is incomplete.');
  }

  return {
    apkUrl: url,
    byteSize: numberValue(record.byteSize),
    channel: normalizeUpdateChannel(stringValue(record.channel)) ?? fallbackChannel,
    fileName: stringValue(record.fileName) || `InfChat-${versionName}-${versionCode}.apk`,
    forceUpdateBelowVersionCode: nullableNumberValue(record.forceUpdateBelowVersionCode),
    minSupportedVersionCode: numberValue(record.minSupportedVersionCode) || 1,
    publishedAt: stringValue(record.publishedAt),
    releaseNotes: stringValue(record.releaseNotes),
    sha256,
    url,
    versionCode,
    versionName,
  };
}

function normalizeUpdateChannel(value?: string | null): AppUpdateChannel | null {
  return value === 'stable' || value === 'beta' ? value : null;
}

function stringExtra(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function nullableNumberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function safeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
