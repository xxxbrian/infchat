// @ts-nocheck
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type Mode = 'prompt' | 'always' | 'never';
type IosProjectMode = 'auto' | 'reuse' | 'clean';
type ColorMode = 'auto' | 'always' | 'never';

const appDir = resolve(import.meta.dir, '..');
const rootDir = resolve(appDir, '../..');
const iosDir = join(appDir, 'ios');
const distIosDir = join(appDir, 'dist', 'ios');

let currentStage = 'setup';
let cleanupIos = false;
let iosProjectMode: IosProjectMode = 'auto';
let uploadMode: Mode = 'prompt';
let assignGroupMode: Mode = 'prompt';
let colorMode: ColorMode = process.env.NO_COLOR ? 'never' : 'auto';
let verbose = false;
let tempRoot = '';
let prebuildLog = '';
let podLog = '';
let archiveLog = '';
let exportLog = '';
let uploadLog = '';
let ascAppId = '';
let ascGroupId = '';
let developmentTeam = '';
let scheme = '';
let workspacePath = '';

const usage =
  'Usage: bun ./scripts/release-ios-local.ts [--ios auto|reuse|clean] [--cleanup-ios|--keep-ios] [--upload|--no-upload] [--assign-group|--no-assign-group] [--verbose] [--color|--no-color]';

function parseIosProjectMode(value: string) {
  if (value === 'auto' || value === 'reuse' || value === 'clean') return value;
  throw new Error(`Invalid --ios value: ${value}\n${usage}`);
}

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  switch (arg) {
    case '--help':
    case '-h':
      console.log(`${usage}

Options:
  --ios auto       Reuse existing ios/ if present; generate it if missing. Default.
  --ios reuse      Reuse ios/ without forcing a clean prebuild.
  --ios clean      Recreate ios/ with expo prebuild --clean.
  --cleanup-ios    Remove apps/mobile/ios after the run.
  --keep-ios       Keep apps/mobile/ios after the run. Default and kept for compatibility.
  --upload         Upload the IPA to App Store Connect without prompting.
  --no-upload      Build the IPA locally without uploading.
  --assign-group   Assign the uploaded build to ASC_GROUP_ID without prompting.
  --no-assign-group Skip TestFlight group assignment.
  --verbose        Stream command output while also writing logs.
  --color          Force colored output.
  --no-color       Disable colored output. Also disabled by NO_COLOR.

Environment:
  ASC_APP_ID, ASC_GROUP_ID, DEVELOPMENT_TEAM, SCHEME
  EXPO_PUBLIC_POCKETBASE_URL, EXPO_PUBLIC_LIVEKIT_URL
  EXPO_PUBLIC_APNS_ENV must be unset or production for TestFlight/App Store builds

Examples:
  bun ./scripts/release-ios-local.ts --no-upload
  bun ./scripts/release-ios-local.ts --ios clean --upload --assign-group
`);
      process.exit(0);
    case '--ios': {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for --ios\n${usage}`);
      iosProjectMode = parseIosProjectMode(value);
      index += 1;
      break;
    }
    case '--keep-ios':
      cleanupIos = false;
      break;
    case '--cleanup-ios':
      cleanupIos = true;
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
    case '--upload':
      uploadMode = 'always';
      break;
    case '--no-upload':
      uploadMode = 'never';
      break;
    case '--assign-group':
      assignGroupMode = 'always';
      break;
    case '--no-assign-group':
      assignGroupMode = 'never';
      break;
    default:
      if (arg.startsWith('--ios=')) {
        iosProjectMode = parseIosProjectMode(arg.slice('--ios='.length));
        break;
      }

      throw new Error(`Unknown argument: ${arg}\n${usage}`);
  }
}

function setStage(stage: string) {
  currentStage = stage;
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

function label(text: string) {
  return dim(`${text}:`);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

async function runStep<T>(stage: string, label: string, task: () => Promise<T>) {
  setStage(stage);
  const startedAt = Date.now();
  console.log(`\n${cyan('==>')} ${bold(label)}`);

  try {
    const result = await task();
    console.log(
      `${green('OK')} ${label} completed in ${dim(formatDuration(Date.now() - startedAt))}.`,
    );
    return result;
  } catch (error) {
    console.error(
      `${red('FAIL')} ${label} failed after ${dim(formatDuration(Date.now() - startedAt))}.`,
    );
    throw error;
  }
}

function commandExists(command: string) {
  return spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function ascArgs(args: string[]) {
  if (commandExists('mise')) {
    return { command: 'mise', args: ['exec', '--', 'asc', ...args] };
  }

  if (commandExists('asc')) {
    return { command: 'asc', args };
  }

  throw new Error('asc CLI not found. Install it with mise or make it available on PATH.');
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

  if (options.logFile) {
    writeFileSync(options.logFile, outputText);
  }

  if (code !== 0) {
    const rendered = [command, ...args].join(' ');
    const logHint = options.logFile ? `\nLog: ${options.logFile}` : `\n${outputText}`;
    throw new Error(`Command failed with exit code ${code}: ${rendered}${logHint}`.trim());
  }

  return outputText;
}

async function asc(args: string[], options: { logFile?: string; printOutput?: boolean } = {}) {
  const command = ascArgs(args);
  return run(command.command, command.args, {
    cwd: rootDir,
    logFile: options.logFile,
    printOutput: options.printOutput,
  });
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

async function confirmAction(prompt: string, defaultAnswer: 'Y' | 'N') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(yellow(`Non-interactive terminal detected; skipping prompt: ${prompt}`));
    console.log(dim('Pass an explicit flag to enable this action.'));
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const suffix = defaultAnswer === 'Y' ? '[Y/n]' : '[y/N]';
    const reply = (await rl.question(`${prompt} ${suffix} `)).trim() || defaultAnswer;
    return ['y', 'yes'].includes(reply.toLowerCase());
  } finally {
    rl.close();
  }
}

function cleanup(options: { removeTemp: boolean } = { removeTemp: true }) {
  if (options.removeTemp && tempRoot) {
    rmSync(tempRoot, { force: true, recursive: true });
  }

  if (cleanupIos) {
    rmSync(iosDir, { force: true, recursive: true });
  }
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
  console.error(`\n${red(bold('Local iOS release failed.'))}`);
  console.error(`${label('Stage')} ${yellow(currentStage)}`);
  if (error instanceof Error) console.error(`${label('Error')} ${red(error.message)}`);

  if (currentStage === 'prebuild') printLog('expo prebuild log', prebuildLog);
  if (currentStage === 'pods') printLog('pod install log', podLog);
  if (currentStage === 'archive') printLog('xcodebuild archive log', archiveLog);
  if (currentStage === 'export') printLog('xcodebuild export log', exportLog);
  if (['upload', 'resolve-build', 'assign-group'].includes(currentStage))
    printLog('upload log', uploadLog);

  if (tempRoot) console.error(`\n${yellow('Logs and temporary artifacts kept at:')} ${tempRoot}`);
  cleanup({ removeTemp: false });
  process.exit(1);
}

async function waitForGroupAssignment(buildId: string) {
  if (!ascGroupId) {
    throw new Error('ASC_GROUP_ID is required when assigning a TestFlight group.');
  }

  const attempts = 12;
  const sleepSeconds = 10;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const outputText = await asc([
        'builds',
        'add-groups',
        '--build-id',
        buildId,
        '--group',
        ascGroupId,
        '--pretty',
      ]);
      console.log(outputText);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.includes('another operation is still in progress') ||
        message.includes('is not in a valid state') ||
        message.includes('relationship is not accessible') ||
        message.includes('cannot be added to beta groups');

      if (!retryable || attempt === attempts) throw error;

      console.error(
        yellow(
          `Build not ready for group assignment yet (attempt ${attempt}/${attempts}). Retrying in ${sleepSeconds}s...`,
        ),
      );
      await new Promise((resolveSleep) => setTimeout(resolveSleep, sleepSeconds * 1000));
    }
  }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  loadEnvFile(join(appDir, '.env.production'));
  loadEnvFile(join(appDir, '.env.local'));

  ascAppId = process.env.ASC_APP_ID || '6764232455';
  ascGroupId = process.env.ASC_GROUP_ID || '';
  developmentTeam = process.env.DEVELOPMENT_TEAM || '7N7Y43VZ4J';
  scheme = process.env.SCHEME || 'InfChat';
  workspacePath = join(iosDir, `${scheme}.xcworkspace`);

  if (uploadMode === 'never' && assignGroupMode === 'always') {
    throw new Error('--assign-group requires upload. Remove --no-upload or pass --upload.');
  }
  if (assignGroupMode === 'always' && !ascGroupId) {
    throw new Error('ASC_GROUP_ID is required when using --assign-group.');
  }

  await runStep('setup', 'Validate toolchain and App Store Connect auth', async () => {
    for (const command of ['xcodebuild', 'pod', 'pnpm']) {
      if (!commandExists(command)) throw new Error(`${command} is not available on PATH.`);
    }
    await asc(['auth', 'status']);
  });

  const appConfig = readJson(join(appDir, 'app.json'));
  const appVersion = appConfig.expo.version;
  const bundleId = appConfig.expo.ios.bundleIdentifier;
  const pocketbaseUrl = process.env.EXPO_PUBLIC_POCKETBASE_URL || '';
  const livekitUrl = process.env.EXPO_PUBLIC_LIVEKIT_URL || '';
  const requestedApnsEnv = (process.env.EXPO_PUBLIC_APNS_ENV || '').trim().toLowerCase();
  const apnsEnv = 'production';

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
      'EXPO_PUBLIC_POCKETBASE_URL points to localhost. Refusing to create a TestFlight build for a local backend.',
    );
  }
  if (requestedApnsEnv && requestedApnsEnv !== 'production') {
    throw new Error(
      `EXPO_PUBLIC_APNS_ENV=${requestedApnsEnv} would register TestFlight devices against the wrong APNs environment. Unset it or set EXPO_PUBLIC_APNS_ENV=production.`,
    );
  }

  const nextBuildText = await runStep('resolve-build-number', 'Resolve next ASC build number', () =>
    asc([
      'builds',
      'next-build-number',
      '--app',
      ascAppId,
      '--version',
      appVersion,
      '--platform',
      'IOS',
      '--output',
      'json',
    ]),
  );
  const nextBuildNumber = Number(JSON.parse(nextBuildText).nextBuildNumber || 0);
  if (nextBuildNumber <= 0)
    throw new Error('Failed to resolve next App Store Connect build number.');

  tempRoot = mkdtempSync(join(tmpdir(), 'infchat-ios-release-'));
  const archiveDir = join(tempRoot, 'archive');
  const exportDir = join(tempRoot, 'export');
  mkdirSync(archiveDir);
  mkdirSync(exportDir);

  prebuildLog = join(tempRoot, 'prebuild.log');
  podLog = join(tempRoot, 'pods.log');
  archiveLog = join(tempRoot, 'archive.log');
  exportLog = join(tempRoot, 'export.log');
  uploadLog = join(tempRoot, 'upload.log');

  const archivePath = join(archiveDir, `${scheme}.xcarchive`);
  const exportOptionsPlist = join(archiveDir, 'ExportOptions.plist');
  writeFileSync(
    exportOptionsPlist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${developmentTeam}</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
`,
  );

  const iosDirExistsBefore = existsSync(iosDir);
  const iosAction =
    iosProjectMode === 'clean' ? 'clean' : iosDirExistsBefore ? 'reuse' : 'generate';
  const prebuildArgs = ['exec', 'expo', 'prebuild', '--platform', 'ios'];
  if (iosAction === 'clean') prebuildArgs.push('--clean');

  console.log(`\n${bold('Preparing local iOS release build')}`);
  console.log(`${label('App version')} ${appVersion} (${nextBuildNumber})`);
  console.log(`${label('ASC app ID')} ${ascAppId}`);
  console.log(`${label('Bundle identifier')} ${bundleId}`);
  console.log(`${label('PocketBase URL')} ${pocketbaseUrl}`);
  if (livekitUrl) console.log(`${label('LiveKit URL')} ${livekitUrl}`);
  console.log(`${label('APNs environment')} ${apnsEnv}`);
  console.log(`${label('Temporary logs')} ${tempRoot} ${dim('(kept on failure)')}`);

  if (iosAction === 'clean')
    console.log(`${label('iOS project mode')} clean prebuild (--ios clean)`);
  else if (iosAction === 'reuse')
    console.log(`${label('iOS project mode')} reuse existing ios/ directory`);
  else console.log(`${label('iOS project mode')} generate ios/ directory without forced clean`);
  if (iosProjectMode === 'reuse' && !iosDirExistsBefore) {
    console.log(
      yellow('Requested --ios reuse, but ios/ is missing; generating it without --clean.'),
    );
  }
  console.log(
    cleanupIos
      ? `${label('iOS cleanup')} remove apps/mobile/ios after the run (--cleanup-ios)`
      : `${label('iOS cleanup')} keep apps/mobile/ios after the run`,
  );
  if (iosAction !== 'clean') {
    console.log(
      yellow(
        'Tip: use --ios clean after Expo/RN upgrades, config plugin changes, signing changes, or native dependency issues.',
      ),
    );
  }

  if (uploadMode === 'always' && assignGroupMode === 'always')
    console.log(`${label('Publish mode')} upload and assign TestFlight group`);
  else if (uploadMode === 'always') console.log(`${label('Publish mode')} upload only`);
  else if (uploadMode === 'never') console.log(`${label('Publish mode')} local build only`);
  else console.log(`${label('Publish mode')} prompt during run`);

  const buildEnv = {
    ...process.env,
    EXPO_PUBLIC_APNS_ENV: apnsEnv,
    EXPO_PUBLIC_POCKETBASE_URL: pocketbaseUrl,
    ...(livekitUrl ? { EXPO_PUBLIC_LIVEKIT_URL: livekitUrl } : {}),
  };

  await runStep('prebuild', 'Prepare iOS native project', () =>
    run('pnpm', prebuildArgs, {
      cwd: appDir,
      env: buildEnv,
      logFile: prebuildLog,
      printOutput: verbose,
    }),
  );

  await runStep('pods', 'Install CocoaPods dependencies', () =>
    run('pod', ['install'], {
      cwd: iosDir,
      env: buildEnv,
      logFile: podLog,
      printOutput: verbose,
    }),
  );

  await runStep('archive', 'Archive iOS app with Xcode', () =>
    run(
      'xcodebuild',
      [
        '-workspace',
        workspacePath,
        '-scheme',
        scheme,
        '-configuration',
        'Release',
        '-destination',
        'generic/platform=iOS',
        '-archivePath',
        archivePath,
        '-allowProvisioningUpdates',
        `DEVELOPMENT_TEAM=${developmentTeam}`,
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        `MARKETING_VERSION=${appVersion}`,
        `CURRENT_PROJECT_VERSION=${nextBuildNumber}`,
        'archive',
      ],
      { cwd: iosDir, env: buildEnv, logFile: archiveLog, printOutput: verbose },
    ),
  );
  console.log(`\n${green('Source snapshot is no longer needed by this release build.')}`);
  console.log(green('You can safely continue editing TypeScript/JS files now.'));
  console.log(dim('Export and upload use the completed Xcode archive.'));

  await runStep('export', 'Export IPA', () =>
    run(
      'xcodebuild',
      [
        '-exportArchive',
        '-archivePath',
        archivePath,
        '-exportPath',
        exportDir,
        '-exportOptionsPlist',
        exportOptionsPlist,
        '-allowProvisioningUpdates',
      ],
      { cwd: iosDir, env: buildEnv, logFile: exportLog, printOutput: verbose },
    ),
  );

  const ipaPath = readdirSync(exportDir)
    .filter((entry) => entry.endsWith('.ipa'))
    .map((entry) => join(exportDir, entry))[0];
  if (!ipaPath) throw new Error('xcodebuild export completed but no .ipa was produced.');

  mkdirSync(distIosDir, { recursive: true });
  const stableIpaPath = join(distIosDir, `${scheme}-${appVersion}-${nextBuildNumber}.ipa`);
  copyFileSync(ipaPath, stableIpaPath);
  console.log(`\n${green('IPA exported:')} ${stableIpaPath}`);

  let shouldUpload = false;
  if (uploadMode === 'always') shouldUpload = true;
  if (uploadMode === 'prompt')
    shouldUpload = await confirmAction('Upload IPA to App Store Connect?', 'N');

  if (!shouldUpload) {
    setStage('done');
    console.log(`\n${green(bold('Release build complete.'))}`);
    console.log(`${label('Upload')} skipped`);
    console.log(`${label('App version')} ${appVersion} (${nextBuildNumber})`);
    console.log(`${label('IPA')} ${stableIpaPath}`);
    console.log(`${label('iOS project')} ${cleanupIos ? 'removed' : 'kept'}`);
    cleanup();
    return;
  }

  await runStep('upload', 'Upload IPA to App Store Connect', () =>
    asc(
      [
        'builds',
        'upload',
        '--app',
        ascAppId,
        '--ipa',
        stableIpaPath,
        '--version',
        appVersion,
        '--build-number',
        String(nextBuildNumber),
        '--wait',
        '--pretty',
      ],
      { logFile: uploadLog, printOutput: true },
    ),
  );

  const buildInfoText = await runStep('resolve-build', 'Resolve uploaded ASC build ID', () =>
    asc([
      'builds',
      'info',
      '--app',
      ascAppId,
      '--version',
      appVersion,
      '--build-number',
      String(nextBuildNumber),
      '--platform',
      'IOS',
      '--output',
      'json',
    ]),
  );
  const buildInfo = JSON.parse(buildInfoText);
  const buildId = buildInfo.data?.id || buildInfo.id || '';
  if (!buildId) throw new Error('Failed to resolve uploaded App Store Connect build ID.');

  let shouldAssignGroup = false;
  if (assignGroupMode === 'always') shouldAssignGroup = true;
  if (assignGroupMode === 'prompt' && ascGroupId)
    shouldAssignGroup = await confirmAction('Assign uploaded build to the TestFlight group?', 'Y');

  if (shouldAssignGroup) {
    await runStep('assign-group', 'Assign build to TestFlight group', () =>
      waitForGroupAssignment(buildId),
    );
  } else {
    console.log(yellow('Skipped TestFlight group assignment.'));
  }

  setStage('done');
  console.log(`\n${green(bold('Release build complete.'))}`);
  console.log(`${label('App version')} ${appVersion} (${nextBuildNumber})`);
  console.log(`${label('IPA')} ${stableIpaPath}`);
  console.log(`${label('Upload')} completed`);
  console.log(`${label('ASC build ID')} ${buildId}`);
  console.log(`${label('ASC app ID')} ${ascAppId}`);
  if (ascGroupId) console.log(`${label('Group ID')} ${ascGroupId}`);
  console.log(`${label('iOS project')} ${cleanupIos ? 'removed' : 'kept'}`);
  cleanup();
}

main().catch(handleError);
