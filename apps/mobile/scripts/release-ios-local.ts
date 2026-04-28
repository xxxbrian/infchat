// @ts-nocheck
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type Mode = 'prompt' | 'always' | 'never';

const appDir = resolve(import.meta.dir, '..');
const rootDir = resolve(appDir, '../..');

let currentStage = 'setup';
let keepIos = false;
let uploadMode: Mode = 'prompt';
let assignGroupMode: Mode = 'prompt';
let tempRoot = '';
let prebuildLog = '';
let podLog = '';
let archiveLog = '';
let exportLog = '';
let uploadLog = '';

const args = process.argv.slice(2);
for (const arg of args) {
  switch (arg) {
    case '--help':
    case '-h':
      console.log(
        'Usage: bun ./scripts/release-ios-local.ts [--keep-ios] [--upload|--no-upload] [--assign-group|--no-assign-group]',
      );
      process.exit(0);
    case '--keep-ios':
      keepIos = true;
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
      throw new Error(
        `Unknown argument: ${arg}\nUsage: bun ./scripts/release-ios-local.ts [--keep-ios] [--upload|--no-upload] [--assign-group|--no-assign-group]`,
      );
  }
}

const ascAppId = process.env.ASC_APP_ID || '6764232455';
const ascGroupId = process.env.ASC_GROUP_ID || '';
const developmentTeam = process.env.DEVELOPMENT_TEAM || '7N7Y43VZ4J';
const scheme = process.env.SCHEME || 'InfChat';
const workspacePath = join(appDir, 'ios', `${scheme}.xcworkspace`);

function setStage(stage: string) {
  currentStage = stage;
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
    throw new Error(`Command failed with exit code ${code}: ${rendered}\n${outputText}`.trim());
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

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
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
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = createInterface({ input, output });
  try {
    const suffix = defaultAnswer === 'Y' ? '[Y/n]' : '[y/N]';
    const reply = (await rl.question(`${prompt} ${suffix} `)).trim() || defaultAnswer;
    return ['y', 'yes'].includes(reply.toLowerCase());
  } finally {
    rl.close();
  }
}

function cleanup() {
  for (const path of [tempRoot, prebuildLog, podLog, archiveLog, exportLog, uploadLog]) {
    if (path) rmSync(path, { force: true, recursive: true });
  }

  if (!keepIos) {
    rmSync(join(appDir, 'ios'), { force: true, recursive: true });
  }
}

function printLog(label: string, path: string) {
  if (!path || !existsSync(path)) return;
  console.error(`--- ${label} ---`);
  console.error(readFileSync(path, 'utf8'));
}

function handleError(error: unknown) {
  console.error('\nLocal iOS release failed.');
  console.error(`Stage: ${currentStage}`);
  if (error instanceof Error) console.error(`Error: ${error.message}`);

  if (currentStage === 'prebuild') printLog('expo prebuild log', prebuildLog);
  if (currentStage === 'pods') printLog('pod install log', podLog);
  if (currentStage === 'archive') printLog('xcodebuild archive log', archiveLog);
  if (currentStage === 'export') printLog('xcodebuild export log', exportLog);
  if (['upload', 'resolve-build', 'assign-group'].includes(currentStage))
    printLog('upload log', uploadLog);

  cleanup();
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
        `Build not ready for group assignment yet (attempt ${attempt}/${attempts}). Retrying in ${sleepSeconds}s...`,
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

  for (const command of ['xcodebuild', 'pod', 'pnpm']) {
    if (!commandExists(command)) throw new Error(`${command} is not available on PATH.`);
  }
  await asc(['auth', 'status']);

  const appConfig = readJson(join(appDir, 'app.json'));
  const appVersion = appConfig.expo.version;
  const bundleId = appConfig.expo.ios.bundleIdentifier;
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
      'EXPO_PUBLIC_POCKETBASE_URL points to localhost. Refusing to create a TestFlight build for a local backend.',
    );
  }

  const nextBuildText = await asc([
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
  ]);
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

  console.log('Preparing local iOS release build');
  console.log(`App version: ${appVersion} (${nextBuildNumber})`);
  console.log(`ASC app ID: ${ascAppId}`);
  console.log(`Bundle identifier: ${bundleId}`);
  console.log(`PocketBase URL: ${pocketbaseUrl}`);
  if (livekitUrl) console.log(`LiveKit URL: ${livekitUrl}`);

  if (uploadMode === 'always' && assignGroupMode === 'always')
    console.log('Publish mode: upload and assign TestFlight group');
  else if (uploadMode === 'always') console.log('Publish mode: upload only');
  else if (uploadMode === 'never') console.log('Publish mode: local build only');
  else console.log('Publish mode: prompt during run');

  const buildEnv = {
    ...process.env,
    EXPO_PUBLIC_POCKETBASE_URL: pocketbaseUrl,
    ...(livekitUrl ? { EXPO_PUBLIC_LIVEKIT_URL: livekitUrl } : {}),
  };

  setStage('prebuild');
  await run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--clean'], {
    cwd: appDir,
    env: buildEnv,
    logFile: prebuildLog,
  });

  setStage('pods');
  await run('pod', ['install'], {
    cwd: join(appDir, 'ios'),
    env: buildEnv,
    logFile: podLog,
  });

  setStage('archive');
  await run(
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
    { cwd: join(appDir, 'ios'), env: buildEnv, logFile: archiveLog },
  );

  setStage('export');
  await run(
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
    { cwd: join(appDir, 'ios'), env: buildEnv, logFile: exportLog },
  );

  const ipaPath = readdirSync(exportDir)
    .filter((entry) => entry.endsWith('.ipa'))
    .map((entry) => join(exportDir, entry))[0];
  if (!ipaPath) throw new Error('xcodebuild export completed but no .ipa was produced.');

  let shouldUpload = false;
  if (uploadMode === 'always') shouldUpload = true;
  if (uploadMode === 'prompt')
    shouldUpload = await confirmAction('Upload IPA to App Store Connect?', 'N');

  if (!shouldUpload) {
    setStage('done');
    console.log('\nSkipped App Store Connect upload.');
    console.log(`IPA path: ${ipaPath}`);
    if (!keepIos)
      console.log(
        'The exported IPA is in a temporary directory and will be removed when the script exits. Use --keep-ios while debugging the native project.',
      );
    cleanup();
    return;
  }

  console.log('Uploading IPA to App Store Connect...');
  setStage('upload');
  await asc(
    [
      'builds',
      'upload',
      '--app',
      ascAppId,
      '--ipa',
      ipaPath,
      '--version',
      appVersion,
      '--build-number',
      String(nextBuildNumber),
      '--wait',
      '--pretty',
    ],
    { logFile: uploadLog, printOutput: true },
  );

  setStage('resolve-build');
  const buildInfoText = await asc([
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
  ]);
  const buildInfo = JSON.parse(buildInfoText);
  const buildId = buildInfo.data?.id || buildInfo.id || '';
  if (!buildId) throw new Error('Failed to resolve uploaded App Store Connect build ID.');

  let shouldAssignGroup = false;
  if (assignGroupMode === 'always') shouldAssignGroup = true;
  if (assignGroupMode === 'prompt' && ascGroupId)
    shouldAssignGroup = await confirmAction('Assign uploaded build to the TestFlight group?', 'Y');

  if (shouldAssignGroup) {
    console.log('Assigning build to TestFlight group...');
    setStage('assign-group');
    await waitForGroupAssignment(buildId);
  } else {
    console.log('Skipped TestFlight group assignment.');
  }

  setStage('done');
  console.log('\nDone.');
  console.log(`App version: ${appVersion} (${nextBuildNumber})`);
  console.log(`ASC build ID: ${buildId}`);
  console.log(`ASC app ID: ${ascAppId}`);
  if (ascGroupId) console.log(`Group ID: ${ascGroupId}`);
  if (keepIos) console.log('Kept generated ios/ directory because --keep-ios was provided.');
  else console.log('Removed generated ios/ directory.');
  cleanup();
}

main().catch(handleError);
