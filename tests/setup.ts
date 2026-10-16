import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ConsoleCapture,
  ConsoleCaptureStore,
  ConsoleMethod,
  MockClient,
  MockSession,
  MockShellResult,
  MockShellRunner,
  ShellCallRecord,
  ToastBody,
  ToastCall,
} from '../src/types/testing.js';
import type { PluginEvent, ShellResult } from '../src/types/opencode-sdk.js';
import { resetPowerShellRunner, setPowerShellRunner } from '../src/util/powershell.js';

const TEST_TEMP_BASE = path.join(os.tmpdir(), 'opencode-smart-voice-notify-tests');

let currentTestDir: string | null = null;

process.env.NODE_ENV = 'test';
process.env.SMART_VOICE_NOTIFY_DEBUG = 'false';

type GenericObject = Record<string, unknown>;

interface MockShellRunnerOptions {
  handler?: (
    command: string,
    callRecord: ShellCallRecord,
  ) =>
    | ShellResult
    | Partial<ShellResult>
    | Buffer
    | null
    | undefined
    | Promise<ShellResult | Partial<ShellResult> | Buffer | null | undefined>;
}

const getDefaultShellResult = (): ShellResult => ({
  stdout: Buffer.from(''),
  stderr: Buffer.from(''),
  exitCode: 0,
  text: () => '',
  toString: () => '',
});

export function createTestTempDir(): string {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const tempDir = path.join(TEST_TEMP_BASE, uniqueId);

  fs.mkdirSync(tempDir, { recursive: true });
  process.env.OPENCODE_CONFIG_DIR = tempDir;
  currentTestDir = tempDir;

  return tempDir;
}

export function cleanupTestTempDir(): void {
  if (currentTestDir && fs.existsSync(currentTestDir)) {
    try {
      fs.rmSync(currentTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
    currentTestDir = null;
  }

  delete process.env.OPENCODE_CONFIG_DIR;
}

export function getTestTempDir(): string {
  if (!currentTestDir) {
    return createTestTempDir();
  }
  return currentTestDir;
}

export function createTestConfig(config: GenericObject, filename = 'smart-voice-notify.jsonc'): string {
  const tempDir = getTestTempDir();
  const configPath = path.join(tempDir, filename);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

export function createMinimalConfig<TOverrides extends GenericObject>(
  overrides: TOverrides = {} as TOverrides,
):
  {
    _configVersion: string;
    enabled: boolean;
    notificationMode: 'sound-first';
    enableTTS: boolean;
    enableTTSReminder: boolean;
    enableSound: boolean;
    enableToast: boolean;
    enableAIMessages: boolean;
    debugLog: boolean;
  } & TOverrides {
  return {
    _configVersion: '1.0.0',
    enabled: true,
    notificationMode: 'sound-first',
    enableTTS: false,
    enableTTSReminder: false,
    enableSound: false,
    enableToast: false,
    enableAIMessages: false,
    debugLog: false,
    ...overrides,
  };
}

export function createTestAssets(): string {
  const tempDir = getTestTempDir();
  const assetsDir = path.join(tempDir, 'assets');

  fs.mkdirSync(assetsDir, { recursive: true });

  const minimalMp3 = Buffer.from([
    0xff, 0xfb, 0x90, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);

  const soundFiles = [
    'Soft-high-tech-notification-sound-effect.mp3',
    'Machine-alert-beep-sound-effect.mp3',
    'test-sound.mp3',
  ];

  for (const file of soundFiles) {
    fs.writeFileSync(path.join(assetsDir, file), minimalMp3);
  }

  return assetsDir;
}

export function createTestLogsDir(): string {
  const tempDir = getTestTempDir();
  const logsDir = path.join(tempDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function readTestFile(relativePath: string): string | null {
  const tempDir = getTestTempDir();
  const filePath = path.join(tempDir, relativePath);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function testFileExists(relativePath: string): boolean {
  const tempDir = getTestTempDir();
  const filePath = path.join(tempDir, relativePath);
  return fs.existsSync(filePath);
}

export function createMockShellRunner(options: MockShellRunnerOptions = {}): MockShellRunner {
  const calls: ShellCallRecord[] = [];

  const mockRunner = ((strings: TemplateStringsArray, ...values: Array<unknown>) => {
    let command = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      command += String(values[index]) + (strings[index + 1] ?? '');
    }

    const callRecord: ShellCallRecord = {
      command: command.trim(),
      timestamp: Date.now(),
    };
    calls.push(callRecord);

    const promise = (async (): Promise<ShellResult> => {
      if (options.handler) {
        const handlerResult = await options.handler(callRecord.command, callRecord);
        if (handlerResult && typeof handlerResult === 'object' && !Buffer.isBuffer(handlerResult)) {
          return {
            ...getDefaultShellResult(),
            ...(handlerResult as Partial<ShellResult>),
          };
        }
      }

      return getDefaultShellResult();
    })();

    const mockPromise = promise as MockShellResult;
    mockPromise.quiet = () => mockPromise;
    mockPromise.nothrow = () => mockPromise;
    mockPromise.timeout = () => mockPromise;

    return mockPromise;
  }) as MockShellRunner;

  mockRunner.getCalls = () => [...calls];
  mockRunner.getLastCall = () => calls[calls.length - 1];
  // PowerShell invocations bypass the shell runner (see src/util/powershell.ts);
  // mirror them here so they are visible alongside the runner's own calls.
  setShellCallSink((record) => calls.push(record));
  mockRunner.getCallCount = () => calls.length;
  mockRunner.reset = () => {
    calls.length = 0;
  };
  mockRunner.wasCalledWith = (pattern: string | RegExp) =>
    calls.some((record) =>
      typeof pattern === 'string' ? record.command.includes(pattern) : pattern.test(record.command),
    );

  return mockRunner;
}

export function createMockClient(): MockClient {
  const toastCalls: ToastCall[] = [];
  const sessionData = new Map<string, MockSession>();

  const client: MockClient = {
    tui: {
      showToast: async ({ body }: { body: ToastBody & { title?: string } }) => {
        toastCalls.push({
          message: body.message,
          variant: body.variant,
          duration: body.duration,
          timestamp: Date.now(),
        });
        return { success: true };
      },
      getToastCalls: () => [...toastCalls],
      resetToastCalls: () => {
        toastCalls.length = 0;
      },
    },

    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        const session =
          sessionData.get(id) ??
          ({
            id,
            parentID: null,
            status: 'idle',
          } as MockSession);
        return { data: session };
      },
      setMockSession: (id: string, data: Partial<MockSession>) => {
        sessionData.set(id, { id, ...data });
      },
      clearMockSessions: () => {
        sessionData.clear();
      },
    },

    app: {
      log: async (_input: unknown) => ({ success: true }),
    },

    permission: {
      reply: async (_input: unknown) => ({ success: true }),
    },

    question: {
      reply: async (_input: unknown) => ({ success: true }),
      reject: async (_input: unknown) => ({ success: true }),
    },
  };

  return client;
}

export function createMockEvent(type: PluginEvent['type'], properties: GenericObject = {}): PluginEvent {
  const sessionIdFromProperties = properties.sessionID;
  const sessionID =
    typeof sessionIdFromProperties === 'string'
      ? sessionIdFromProperties
      : `test-session-${Date.now()}`;

  return {
    type,
    properties: {
      sessionID,
      ...properties,
    },
  };
}

export const mockEvents = {
  sessionIdle: (sessionID?: string): PluginEvent => createMockEvent('session.idle', { sessionID }),

  sessionError: (sessionID?: string): PluginEvent => createMockEvent('session.error', { sessionID }),

  sessionCreated: (sessionID?: string): PluginEvent =>
    createMockEvent('session.created', {
      sessionID,
      info: { id: sessionID },
    }),

  permissionAsked: (id?: string, sessionID?: string): PluginEvent =>
    createMockEvent('permission.asked', {
      id: id ?? `perm-${Date.now()}`,
      sessionID,
    }),

  permissionReplied: (requestID: string, reply = 'once'): PluginEvent =>
    createMockEvent('permission.replied', {
      requestID,
      reply,
    }),

  questionAsked: (
    id?: string,
    sessionID?: string,
    questions: Array<Record<string, unknown>> = [{ text: 'Test question?' }],
  ): PluginEvent =>
    createMockEvent('question.asked', {
      id: id ?? `q-${Date.now()}`,
      sessionID,
      questions,
    }),

  questionReplied: (requestID: string, answers: Array<Array<string>> = [['answer']]): PluginEvent =>
    createMockEvent('question.replied', {
      requestID,
      answers,
    }),

  questionRejected: (requestID: string): PluginEvent =>
    createMockEvent('question.rejected', {
      requestID,
    }),

  messageUpdated: (messageId?: string, role = 'user', sessionID?: string): PluginEvent =>
    createMockEvent('message.updated', {
      sessionID,
      info: {
        id: messageId ?? `msg-${Date.now()}`,
        role,
        time: { created: Date.now() / 1000 },
      },
    }),
};

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 50,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = await condition();
    if (result) {
      return;
    }
    await wait(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

beforeAll(() => {
  if (!fs.existsSync(TEST_TEMP_BASE)) {
    fs.mkdirSync(TEST_TEMP_BASE, { recursive: true });
  }
});

afterAll(() => {
  try {
    const contents = fs.readdirSync(TEST_TEMP_BASE);
    if (contents.length === 0) {
      fs.rmdirSync(TEST_TEMP_BASE);
    }
  } catch {
    // Ignore cleanup errors.
  }
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  // Windows audio, SAPI, volume and idle probes all run PowerShell scripts
  // (see src/util/powershell.ts).  Swap in a recording fake so no test ever
  // spawns a real PowerShell process or plays real audio.
  installPowerShellRecorder();
});

afterEach(async () => {
  await disposeTrackedPlugins();
  uninstallPowerShellRecorder();
  cleanupTestTempDir();
});

// ============================================================
// Plugin lifetime tracking
// ============================================================
// Several e2e tests create a plugin and never dispose it, so its reminder
// timers keep firing during *later* tests.  Previously that was invisible
// (each plugin held its own shell runner), but now PowerShell calls land in a
// process-wide recorder, so a stale timer would show up in an unrelated test's
// call list.  `trackPlugin` disposes everything it created after each test.

const trackedPlugins: Array<{ dispose?: () => void | Promise<void> }> = [];

export function trackPlugin<T extends { dispose?: () => void | Promise<void> }>(plugin: T): T {
  trackedPlugins.push(plugin);
  return plugin;
}

async function disposeTrackedPlugins(): Promise<void> {
  while (trackedPlugins.length > 0) {
    const plugin = trackedPlugins.pop();
    try {
      await plugin?.dispose?.();
    } catch {
      // ignore
    }
  }
}

export function createConsoleCapture(): ConsoleCapture {
  const logs: ConsoleCaptureStore = {
    log: [],
    warn: [],
    error: [],
    info: [],
    debug: [],
  };

  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  let capturing = false;
  const methods = Object.keys(original) as ConsoleMethod[];
  const consoleRef = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
  const get = ((type?: ConsoleMethod) => (type ? logs[type] : logs)) as ConsoleCapture['get'];

  return {
    start() {
      if (capturing) {
        return;
      }
      capturing = true;

      for (const type of methods) {
        consoleRef[type] = (...args: unknown[]) => {
          logs[type].push(args);
        };
      }
    },

    stop() {
      if (!capturing) {
        return;
      }
      capturing = false;

      for (const [type, fn] of Object.entries(original) as Array<[
        ConsoleMethod,
        (...args: unknown[]) => void,
      ]>) {
        consoleRef[type] = fn;
      }
    },

    get,

    clear() {
      for (const type of methods) {
        logs[type].length = 0;
      }
    },
  };
}

export const platform = os.platform();
export const isWindows = platform === 'win32';
export const isMacOS = platform === 'darwin';
export const isLinux = platform === 'linux';

// ============================================================
// PowerShell recorder
// ============================================================
// Windows playback, SAPI, volume and idle probes all run PowerShell scripts
// through `src/util/powershell.ts`, which spawns `powershell.exe` directly
// with an argv vector (passing the script through a shell corrupts it — see the
// module comment).  That means the calls no longer show up on the mock `$`
// shell runner, so the recorder below stands in for it and lets the existing
// call-count assertions keep working.
//
//   installPowerShellRecorder()  – install a fake runner (call in beforeEach)
//   uninstallPowerShellRecorder() – restore the real runner
//   getPowerShellCalls()          – recorded scripts as ShellCallRecord-like
//   scriptRunner({ exitCode, stdout, stderr }) – configure the fake's reply

interface PowerShellRecorderState {
  calls: ShellCallRecord[];
  /** Parallel to `calls`: whether the record was mirrored into a mock shell. */
  mirrored: boolean[];
  result: { exitCode: number; stdout: string; stderr: string };
  respond: Array<{ match: RegExp; exitCode?: number; stdout?: string; stderr?: string }>;
}

const powershellRecorder: PowerShellRecorderState = {
  calls: [],
  mirrored: [],
  result: { exitCode: 0, stdout: '', stderr: '' },
  respond: [],
};

/**
 * Where PowerShell calls should also be recorded.
 *
 * PowerShell now runs through `src/util/powershell.ts` instead of the `$` shell
 * runner, but conceptually it is still just "the plugin ran a command", so the
 * recorder mirrors every script into the active mock shell runner.  That keeps
 * existing assertions like `mockShell.wasCalledWith('powershell.exe')` valid
 * without every test having to learn about a second call channel.
 */
let shellCallSink: ((record: ShellCallRecord) => void) | null = null;

export function setShellCallSink(sink: ((record: ShellCallRecord) => void) | null): void {
  shellCallSink = sink;
}

/** Configure how the fake PowerShell runner replies to the next script(s). */
export function scriptRunner(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /**
   * Per-script replies matched against the script body.  Needed because the
   * idle probe, the volume probe and the playback scripts all share one
   * runner, and they have to return different stdout.
   */
  respond?: Array<{ match: RegExp | string; exitCode?: number; stdout?: string; stderr?: string }>;
}): void {
  powershellRecorder.result = {
    exitCode: result.exitCode ?? powershellRecorder.result.exitCode,
    stdout: result.stdout ?? powershellRecorder.result.stdout,
    stderr: result.stderr ?? powershellRecorder.result.stderr,
  };
  if (result.respond) {
    powershellRecorder.respond = result.respond.map((entry) => ({
      match: typeof entry.match === 'string' ? new RegExp(escapeRegExp(entry.match)) : entry.match,
      exitCode: entry.exitCode,
      stdout: entry.stdout,
      stderr: entry.stderr,
    }));
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const renderPowerShellCommand = (script: string): string =>
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${script}`;

export function installPowerShellRecorder(): void {
  powershellRecorder.calls = [];
  powershellRecorder.mirrored = [];
  powershellRecorder.respond = [];
  setPowerShellRunner(async (script) => {
    const record: ShellCallRecord = {
      command: renderPowerShellCommand(script),
      timestamp: Date.now(),
    };
    powershellRecorder.calls.push(record);
    powershellRecorder.mirrored.push(shellCallSink !== null);
    shellCallSink?.(record);

    const reply = powershellRecorder.respond.find((entry) => entry.match.test(script));
    return {
      stdout: reply?.stdout ?? powershellRecorder.result.stdout,
      stderr: reply?.stderr ?? powershellRecorder.result.stderr,
      exitCode: reply?.exitCode ?? powershellRecorder.result.exitCode,
    };
  });
}

export function uninstallPowerShellRecorder(): void {
  shellCallSink = null;
  resetPowerShellRunner();
}

/** Recorded PowerShell scripts, shaped like shell-runner calls for assertions. */
export function getPowerShellCalls(): ShellCallRecord[] {
  return [...powershellRecorder.calls];
}

/** Reset the recorded calls without uninstalling the fake. */
export function resetPowerShellCalls(): void {
  powershellRecorder.calls = [];
  powershellRecorder.mirrored = [];
}

/** True when `cmd` is the WPF (.NET) or MCI playback backend. */
const isPlaybackScript = (cmd: string): boolean =>
  cmd.includes('System.Windows.Media.MediaPlayer') || cmd.includes('mciSendString');

/** True when `cmd` is the Windows SAPI speech-synthesis backend. */
const isSpeechScript = (cmd: string): boolean => cmd.includes('System.Speech') && cmd.includes('SpeakSsml');

/**
 * Shell-runner calls plus any recorded PowerShell scripts that were not mirrored
 * into that runner (e.g. when a test builds the TTS factory without a `$`).
 */
function collectRecordedCalls(shell: MockShellRunner): ShellCallRecord[] {
  const unmirrored = getPowerShellCalls().filter((_, index) => !powershellRecorder.mirrored[index]);
  return [...shell.getCalls(), ...unmirrored];
}

export function getTTSCalls(shell: MockShellRunner): ShellCallRecord[] {
  return collectRecordedCalls(shell).filter((record) => {
    const cmd = record.command;

    if (cmd.includes('powershell.exe')) {
      return isPlaybackScript(cmd) || isSpeechScript(cmd);
    }

    if (cmd.includes('paplay') || cmd.includes('aplay') || cmd.includes('afplay')) {
      return true;
    }

    if (cmd.includes('say ')) {
      return true;
    }

    return false;
  });
}

export function getAudioCalls(shell: MockShellRunner): ShellCallRecord[] {
  return collectRecordedCalls(shell).filter((record) => {
    const cmd = record.command;

    if (cmd.includes('powershell.exe')) {
      return isPlaybackScript(cmd) || isSpeechScript(cmd);
    }

    if (cmd.includes('edge-tts') && cmd.includes('--write-media')) {
      return true;
    }

    if (cmd.includes('paplay') || cmd.includes('aplay')) {
      return true;
    }

    if (cmd.includes('afplay')) {
      return true;
    }

    if (cmd.includes('say ')) {
      return true;
    }

    return false;
  });
}

export function getTestTTSEngine(): 'sapi' | 'edge' {
  return isWindows ? 'sapi' : 'edge';
}

export function wasTTSCalled(shell: MockShellRunner): boolean {
  return getTTSCalls(shell).length > 0;
}

export default {
  createTestTempDir,
  cleanupTestTempDir,
  getTestTempDir,
  createTestConfig,
  createMinimalConfig,
  createTestAssets,
  createTestLogsDir,
  readTestFile,
  testFileExists,
  createMockShellRunner,
  createMockClient,
  createMockEvent,
  mockEvents,
  wait,
  waitFor,
  createConsoleCapture,
  trackPlugin,
  platform,
  isWindows,
  isMacOS,
  isLinux,
  getTTSCalls,
  getAudioCalls,
  getTestTTSEngine,
  wasTTSCalled,
  installPowerShellRecorder,
  uninstallPowerShellRecorder,
  getPowerShellCalls,
  resetPowerShellCalls,
  scriptRunner,
};
