// @ts-nocheck
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type AndroidProjectMode = 'auto' | 'clean' | 'reuse';
type Channel = 'beta' | 'stable';
type ColorMode = 'auto' | 'always' | 'never';
type Mode = 'always' | 'never';

const appDir = resolve(import.meta.dir, '..');
const rootDir = resolve(appDir, '../..');
const androidDir = join(appDir, 'android');
const distAndroidDir = join(appDir, 'dist', 'android');
const releaseRootKey = 'infchat/releases';

let androidProjectMode: AndroidProjectMode = 'auto';
let channel: Channel = 'beta';
let colorMode: ColorMode = process.env.NO_COLOR ? 'never' : 'auto';
let currentStage = 'setup';
let publishMode: Mode = 'always';
let releaseNotes = '';
let uploadMode: Mode = 'always';
let verbose = false;
let requestedVersionCode = 0;
let tempRoot = '';
let prebuildLog = '';
let gradleLog = '';

const usage =
  'Usage: bun ./scripts/release-android-local.ts [--channel beta|stable] [--version-code N] [--android auto|reuse|clean] [--upload|--no-upload] [--publish|--no-publish] [--release-notes TEXT] [--verbose] [--color|--no-color]';

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  switch (arg) {
    case '--help':
    case '-h':
      console.log(`${usage}

Options:
  --channel beta|stable  Release channel. Defaults to beta.
  --version-code N       Override the auto-resolved global Android versionCode.
  --android auto         Reuse existing android/ if present; generate if missing. Default.
  --android reuse        Reuse android/ without forcing a clean prebuild.
  --android clean        Recreate android/ with expo prebuild --clean.
  --upload               Upload APK to the downloads bucket. Default.
  --no-upload            Build APK locally only.
  --publish              Update the selected channel index JSON. Default.
  --no-publish           Upload APK without changing the selected channel.
  --release-notes TEXT   Release notes written to the channel JSON when publishing.
  --verbose              Stream command output while also writing logs.
  --color                Force colored output.
  --no-color             Disable colored output. Also disabled by NO_COLOR.

Environment:
  INFCHAT_DOWNLOADS_BUCKET, INFCHAT_DOWNLOADS_PUBLIC_BASE_URL
  INFCHAT_DOWNLOADS_S3_ENDPOINT, INFCHAT_DOWNLOADS_S3_REGION
  INFCHAT_DOWNLOADS_S3_ACCESS_KEY_ID, INFCHAT_DOWNLOADS_S3_SECRET_ACCESS_KEY
  INFCHAT_DOWNLOADS_S3_FORCE_PATH_STYLE=true|false
  INFCHAT_ANDROID_RELEASE_KEYSTORE_PATH, INFCHAT_ANDROID_RELEASE_KEYSTORE_PASSWORD
  INFCHAT_ANDROID_RELEASE_KEY_ALIAS, INFCHAT_ANDROID_RELEASE_KEY_PASSWORD
  EXPO_PUBLIC_POCKETBASE_URL, EXPO_PUBLIC_LIVEKIT_URL
`);
      process.exit(0);
    case '--android': {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for --android\n${usage}`);
      androidProjectMode = parseAndroidProjectMode(value);
      index += 1;
      break;
    }
    case '--channel': {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for --channel\n${usage}`);
      channel = parseChannel(value);
      index += 1;
      break;
    }
    case '--version-code': {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --version-code value\n${usage}`);
      }
      requestedVersionCode = value;
      index += 1;
      break;
    }
    case '--release-notes': {
      releaseNotes = args[index + 1] ?? '';
      index += 1;
      break;
    }
    case '--upload':
      uploadMode = 'always';
      break;
    case '--no-upload':
      uploadMode = 'never';
      publishMode = 'never';
      break;
    case '--publish':
      publishMode = 'always';
      break;
    case '--no-publish':
      publishMode = 'never';
      break;
    case '--verbose':
      verbose = true;
      break;
    case '--color':
      colorMode = 'always';
      break;
    case '--no-color':
      colorMode = 'never';
      break;
    default:
      if (arg.startsWith('--channel=')) {
        channel = parseChannel(arg.slice('--channel='.length));
        break;
      }
      if (arg.startsWith('--android=')) {
        androidProjectMode = parseAndroidProjectMode(arg.slice('--android='.length));
        break;
      }
      if (arg.startsWith('--version-code=')) {
        const value = Number(arg.slice('--version-code='.length));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`Invalid --version-code value\n${usage}`);
        }
        requestedVersionCode = value;
        break;
      }

      throw new Error(`Unknown argument: ${arg}\n${usage}`);
  }
}

function parseAndroidProjectMode(value: string): AndroidProjectMode {
  if (value === 'auto' || value === 'reuse' || value === 'clean') return value;
  throw new Error(`Invalid --android value: ${value}\n${usage}`);
}

function parseChannel(value: string): Channel {
  if (value === 'beta' || value === 'stable') return value;
  throw new Error(`Invalid --channel value: ${value}\n${usage}`);
}

function shouldUseColor() {
  if (colorMode === 'always') return true;
  if (colorMode === 'never') return false;
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function color(code: number, text: string) {
  if (!shouldUseColor()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const bold = (text: string) => color(1, text);
const dim = (text: string) => color(2, text);
const red = (text: string) => color(31, text);
const green = (text: string) => color(32, text);
const yellow = (text: string) => color(33, text);
const cyan = (text: string) => color(36, text);
const label = (text: string) => dim(`${text}:`);

function formatDuration(ms: number) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

async function runStep<T>(stage: string, stepLabel: string, task: () => Promise<T>) {
  currentStage = stage;
  const startedAt = Date.now();
  console.log(`\n${cyan('==>')} ${bold(stepLabel)}`);
  try {
    const result = await task();
    console.log(
      `${green('OK')} ${stepLabel} completed in ${dim(formatDuration(Date.now() - startedAt))}.`,
    );
    return result;
  } catch (error) {
    console.error(
      `${red('FAIL')} ${stepLabel} failed after ${dim(formatDuration(Date.now() - startedAt))}.`,
    );
    throw error;
  }
}

function commandExists(command: string) {
  return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logFile?: string;
    printOutput?: boolean;
  } = {},
) {
  const chunks: Buffer[] = [];
  const proc = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
    if (options.printOutput) process.stdout.write(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
    if (options.printOutput) process.stderr.write(chunk);
  });
  const code = await new Promise<number | null>((resolveCode) => proc.on('close', resolveCode));
  const outputText = Buffer.concat(chunks).toString('utf8');
  if (options.logFile) writeFileSync(options.logFile, outputText);
  if (code !== 0) {
    const rendered = [command, ...args].join(' ');
    const logHint = options.logFile ? `\nLog: ${options.logFile}` : `\n${outputText}`;
    throw new Error(`Command failed with exit code ${code}: ${rendered}${logHint}`.trim());
  }

  return outputText;
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = process.env[key] || value;
  }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function printLog(logLabel: string, path: string) {
  if (!path || !existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  const maxLines = 120;
  const rendered = lines.slice(-maxLines).join('\n').trim();
  console.error(yellow(`--- ${logLabel} (last ${Math.min(lines.length, maxLines)} lines) ---`));
  if (rendered) console.error(rendered);
  console.error(`${label('Full log')} ${path}`);
}

function handleError(error: unknown) {
  console.error(`\n${red(bold('Local Android release failed.'))}`);
  console.error(`${label('Stage')} ${yellow(currentStage)}`);
  if (error instanceof Error) console.error(`${label('Error')} ${red(error.message)}`);
  if (currentStage === 'prebuild') printLog('expo prebuild log', prebuildLog);
  if (currentStage === 'gradle') printLog('Gradle build log', gradleLog);
  if (tempRoot) console.error(`\n${yellow('Logs and temporary artifacts kept at:')} ${tempRoot}`);
  process.exit(1);
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnv(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function envBool(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(value);
}

function downloadsConfig() {
  const endpoint = optionalEnv('INFCHAT_DOWNLOADS_S3_ENDPOINT');
  const forcePathStyle = envBool('INFCHAT_DOWNLOADS_S3_FORCE_PATH_STYLE', Boolean(endpoint));
  return {
    bucket: requireEnv('INFCHAT_DOWNLOADS_BUCKET'),
    publicBaseUrl: requireEnv('INFCHAT_DOWNLOADS_PUBLIC_BASE_URL').replace(/\/+$/, ''),
    s3: new S3Client({
      credentials: {
        accessKeyId: requireEnv('INFCHAT_DOWNLOADS_S3_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('INFCHAT_DOWNLOADS_S3_SECRET_ACCESS_KEY'),
      },
      endpoint: endpoint || undefined,
      forcePathStyle,
      region: optionalEnv('INFCHAT_DOWNLOADS_S3_REGION', 'auto'),
    }),
  };
}

async function getPublicJson(url: string) {
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function uploadObject(
  config: ReturnType<typeof downloadsConfig>,
  key: string,
  path: string,
  contentType: string,
  cacheControl: string,
) {
  await config.s3.send(
    new PutObjectCommand({
      Body: readFileSync(path),
      Bucket: config.bucket,
      CacheControl: cacheControl,
      ContentType: contentType,
      Key: key,
    }),
  );
}

function sha256File(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stablePublicUrl(publicBaseUrl: string, key: string) {
  return `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function newestVersionCodeFromChannelIndexes(indexes: unknown[]) {
  let newest = 0;
  for (const index of indexes) {
    if (!index || typeof index !== 'object') continue;
    const value = Number((index as { versionCode?: unknown }).versionCode);
    if (Number.isInteger(value) && value > newest) newest = value;
  }

  return newest;
}

function patchAndroidBuildGradle(versionCode: number, versionName: string) {
  const buildGradlePath = join(androidDir, 'app', 'build.gradle');
  if (!existsSync(buildGradlePath)) {
    throw new Error(`Android app build.gradle not found at ${buildGradlePath}.`);
  }
  const original = readFileSync(buildGradlePath, 'utf8');
  const patched = original
    .replace(/versionCode\s+\d+/g, `versionCode ${versionCode}`)
    .replace(/versionName\s+['"][^'"]+['"]/g, `versionName "${versionName}"`);
  if (patched === original) {
    if (
      original.includes(`versionCode ${versionCode}`) &&
      original.includes(`versionName "${versionName}"`)
    ) {
      return;
    }
    throw new Error('Could not patch Android versionCode/versionName in build.gradle.');
  }
  writeFileSync(buildGradlePath, patched);
}

function findReleaseApk() {
  const outputsDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
  if (!existsSync(outputsDir)) {
    throw new Error(`Gradle release output directory not found at ${outputsDir}.`);
  }
  const apk = readdirSync(outputsDir)
    .filter((entry) => entry.endsWith('.apk'))
    .map((entry) => join(outputsDir, entry))
    .find((path) => statSync(path).isFile());
  if (!apk) throw new Error('Gradle release build completed but no APK was produced.');

  return apk;
}

async function main() {
  loadEnvFile(join(appDir, '.env.production'));
  loadEnvFile(join(appDir, '.env.local'));

  await runStep('setup', 'Validate Android release inputs', async () => {
    for (const command of ['pnpm']) {
      if (!commandExists(command)) throw new Error(`${command} is not available on PATH.`);
    }
    if (!commandExists('java')) {
      console.log(
        yellow('java was not found on PATH; Gradle may still locate it through Android Studio.'),
      );
    }
    if (uploadMode === 'always') downloadsConfig();
    if (publishMode === 'always' && uploadMode !== 'always') {
      throw new Error('--publish requires upload. Remove --no-upload or pass --upload.');
    }
  });

  const appConfig = readJson(join(appDir, 'app.json'));
  const appVersion = appConfig.expo.version;
  const packageName = appConfig.expo.android.package;
  const pocketbaseUrl = process.env.EXPO_PUBLIC_POCKETBASE_URL || '';
  const livekitUrl = process.env.EXPO_PUBLIC_LIVEKIT_URL || '';
  if (!pocketbaseUrl) {
    throw new Error(
      'Missing EXPO_PUBLIC_POCKETBASE_URL. Set it in apps/mobile/.env.production or the shell environment.',
    );
  }
  if (
    pocketbaseUrl.startsWith('http://127.0.0.1:') ||
    pocketbaseUrl.startsWith('http://localhost:')
  ) {
    throw new Error(
      'EXPO_PUBLIC_POCKETBASE_URL points to localhost. Refusing to create a release APK for a local backend.',
    );
  }

  const config = uploadMode === 'always' ? downloadsConfig() : null;
  const downloadsPublicBaseUrl = (
    config?.publicBaseUrl || optionalEnv('INFCHAT_DOWNLOADS_PUBLIC_BASE_URL')
  ).replace(/\/+$/, '');
  const channelIndexKey = `${releaseRootKey}/android/channels/${channel}.json`;
  const betaUrl = config
    ? stablePublicUrl(config.publicBaseUrl, `${releaseRootKey}/android/channels/beta.json`)
    : '';
  const stableUrl = config
    ? stablePublicUrl(config.publicBaseUrl, `${releaseRootKey}/android/channels/stable.json`)
    : '';
  const channelIndexes = config
    ? await runStep('resolve-version-code', 'Resolve latest channel indexes', () =>
        Promise.all([getPublicJson(betaUrl), getPublicJson(stableUrl)]),
      )
    : [];
  const versionCode =
    requestedVersionCode || newestVersionCodeFromChannelIndexes(channelIndexes) + 1;
  if (versionCode <= 0) throw new Error('Failed to resolve Android versionCode.');

  tempRoot = mkdtempSync(join(tmpdir(), 'infchat-android-release-'));
  prebuildLog = join(tempRoot, 'prebuild.log');
  gradleLog = join(tempRoot, 'gradle.log');
  mkdirSync(distAndroidDir, { recursive: true });

  const androidDirExistsBefore = existsSync(androidDir);
  const androidAction =
    androidProjectMode === 'clean' ? 'clean' : androidDirExistsBefore ? 'reuse' : 'generate';
  const prebuildArgs = ['exec', 'expo', 'prebuild', '--platform', 'android'];
  if (androidAction === 'clean') prebuildArgs.push('--clean');

  console.log(`\n${bold('Preparing local Android release build')}`);
  console.log(`${label('App version')} ${appVersion} (${versionCode})`);
  console.log(`${label('Package')} ${packageName}`);
  console.log(`${label('Channel')} ${channel}`);
  console.log(`${label('PocketBase URL')} ${pocketbaseUrl}`);
  if (livekitUrl) console.log(`${label('LiveKit URL')} ${livekitUrl}`);
  if (downloadsPublicBaseUrl)
    console.log(`${label('Downloads base URL')} ${downloadsPublicBaseUrl}`);
  console.log(
    `${label('Publish')} ${publishMode === 'always' ? 'update channel index' : 'skip channel index'}`,
  );

  const buildEnv = {
    ...process.env,
    EXPO_PUBLIC_INFCHAT_DOWNLOADS_BASE_URL:
      process.env.EXPO_PUBLIC_INFCHAT_DOWNLOADS_BASE_URL || downloadsPublicBaseUrl,
    EXPO_PUBLIC_INFCHAT_UPDATE_CHANNEL: channel,
    EXPO_PUBLIC_POCKETBASE_URL: pocketbaseUrl,
    ...(livekitUrl ? { EXPO_PUBLIC_LIVEKIT_URL: livekitUrl } : {}),
  };

  await runStep('prebuild', 'Prepare Android native project', () =>
    run('pnpm', prebuildArgs, {
      cwd: appDir,
      env: buildEnv,
      logFile: prebuildLog,
      printOutput: verbose,
    }),
  );
  await runStep('local-properties', 'Write Android SDK local.properties', () =>
    run('bun', ['./scripts/ensure-android-sdk-local-properties.ts'], {
      cwd: appDir,
      env: buildEnv,
      printOutput: verbose,
    }),
  );
  await runStep('android-version', 'Patch Android app version', async () => {
    patchAndroidBuildGradle(versionCode, appVersion);
  });

  const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  await runStep('gradle', 'Build Android release APK', () =>
    run(gradleCommand, [':app:assembleRelease'], {
      cwd: androidDir,
      env: buildEnv,
      logFile: gradleLog,
      printOutput: verbose,
    }),
  );

  const apkPath = findReleaseApk();
  const fileName = `InfChat-${appVersion}-${versionCode}-${channel}.apk`;
  const stableApkPath = join(distAndroidDir, fileName);
  copyFileSync(apkPath, stableApkPath);
  const apkSha256 = sha256File(stableApkPath);
  const byteSize = statSync(stableApkPath).size;
  console.log(`\n${green('APK exported:')} ${stableApkPath}`);
  console.log(`${label('SHA-256')} ${apkSha256}`);

  if (!config || uploadMode !== 'always') {
    currentStage = 'done';
    console.log(`\n${green(bold('Android release build complete.'))}`);
    console.log(`${label('Upload')} skipped`);
    rmSync(tempRoot, { force: true, recursive: true });
    return;
  }

  const apkKey = `${releaseRootKey}/android/apks/${fileName}`;
  await runStep('upload-apk', 'Upload APK to downloads bucket', () =>
    uploadObject(
      config,
      apkKey,
      stableApkPath,
      'application/vnd.android.package-archive',
      'public, max-age=31536000, immutable',
    ),
  );
  const apkUrl = stablePublicUrl(config.publicBaseUrl, apkKey);

  if (publishMode === 'always') {
    const index = {
      app: 'infchat',
      apkUrl,
      byteSize,
      channel,
      fileName,
      forceUpdateBelowVersionCode: null,
      minSupportedVersionCode: 1,
      path: apkKey,
      platform: 'android',
      publishedAt: new Date().toISOString(),
      releaseNotes,
      sha256: apkSha256,
      url: apkUrl,
      versionCode,
      versionName: appVersion,
    };
    const indexPath = join(tempRoot, `${channel}.json`);
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    await runStep('publish-channel', 'Publish Android channel index', () =>
      uploadObject(
        config,
        channelIndexKey,
        indexPath,
        'application/json; charset=utf-8',
        'no-cache',
      ),
    );

    const channelsIndexPath = join(tempRoot, 'index.json');
    const channelsIndex = {
      app: 'infchat',
      channels: [
        {
          id: 'stable',
          label: 'Stable',
          url: stablePublicUrl(
            config.publicBaseUrl,
            `${releaseRootKey}/android/channels/stable.json`,
          ),
        },
        {
          id: 'beta',
          label: 'Beta',
          url: stablePublicUrl(
            config.publicBaseUrl,
            `${releaseRootKey}/android/channels/beta.json`,
          ),
        },
      ],
      platform: 'android',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(channelsIndexPath, `${JSON.stringify(channelsIndex, null, 2)}\n`);
    await runStep('publish-channel-list', 'Publish Android channel list', () =>
      uploadObject(
        config,
        `${releaseRootKey}/android/channels/index.json`,
        channelsIndexPath,
        'application/json; charset=utf-8',
        'no-cache',
      ),
    );
  }

  currentStage = 'done';
  console.log(`\n${green(bold('Android release build complete.'))}`);
  console.log(`${label('App version')} ${appVersion} (${versionCode})`);
  console.log(`${label('APK')} ${stableApkPath}`);
  console.log(`${label('APK URL')} ${apkUrl}`);
  console.log(
    `${label('Channel index')} ${publishMode === 'always' ? stablePublicUrl(config.publicBaseUrl, channelIndexKey) : 'not updated'}`,
  );
  rmSync(tempRoot, { force: true, recursive: true });
}

main().catch(handleError);
