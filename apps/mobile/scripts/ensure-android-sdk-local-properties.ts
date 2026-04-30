import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
  (candidate): candidate is string => Boolean(candidate),
);

if (process.platform === 'darwin') {
  candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
}

if (process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Android', 'Sdk'));
  }
}

const sdkDir = candidates.find((candidate) => existsSync(candidate));

if (!sdkDir) {
  throw new Error(
    [
      'Android SDK location not found.',
      '',
      'Set ANDROID_HOME or ANDROID_SDK_ROOT to your Android SDK path, or install Android Studio SDK.',
      'Default macOS path: ~/Library/Android/sdk',
      'Default Windows path: %LOCALAPPDATA%\\Android\\Sdk',
    ].join('\n'),
  );
}

const androidDir = path.join(process.cwd(), 'android');
mkdirSync(androidDir, { recursive: true });
writeFileSync(
  path.join(androidDir, 'local.properties'),
  `sdk.dir=${sdkDir.replaceAll('\\', '\\\\')}\n`,
);
