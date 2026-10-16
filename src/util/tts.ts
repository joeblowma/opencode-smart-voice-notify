import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PluginConfig } from '../types/config.js';
import type { LinuxPlatformAPI } from '../types/linux.js';
import type { OpenCodeClient, ShellRunner, ToastVariant, TUIToastPayload } from '../types/opencode-sdk.js';
import type { SpeakOptions, TTSAPI, TTSFactoryParams } from '../types/tts.js';

import { loadConfig } from './config.js';
import { createLinuxPlatform } from './linux.js';
import { runPowerShellScript } from './powershell.js';

const getPlatform = (): NodeJS.Platform => os.platform();
// Remove module-level configDir constant that caches process.env prematurely
// const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');

type VoiceCacheEngine = 'openai' | 'elevenlabs' | 'edge' | 'sapi';

interface ElevenLabsErrorLike {
  statusCode?: number;
  message?: string;
}

const getErrorMessage = (error: unknown): string => {
  const maybeError = error as { message?: unknown };
  return String(maybeError?.message ?? error);
};

const outputToString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString();
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
};

const toBufferChunk = (chunk: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
};

/**
 * Gets the current OpenCode config directory
 * @returns
 */
const getConfigDir = (): string => process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');

/**
 * Loads the TTS configuration (shared with the notification plugin)
 * @returns
 */
export const getTTSConfig = (): PluginConfig => {
  return loadConfig('smart-voice-notify', {
    ttsEngine: 'elevenlabs',
    enableTTS: true,
    elevenLabsApiKey: '',
    elevenLabsVoiceId: 'cgSgspJ2msm6clMCkdW9',
    elevenLabsModel: 'eleven_turbo_v2_5',
    elevenLabsStability: 0.5,
    elevenLabsSimilarity: 0.75,
    elevenLabsStyle: 0.5,
    edgeVoice: 'en-US-JennyNeural',
    edgePitch: '+0Hz',
    edgeRate: '+10%',
    sapiVoice: 'Microsoft Zira Desktop',
    sapiRate: -1,
    sapiPitch: 'medium',
    sapiVolume: 'loud',

    // OpenAI-compatible TTS settings
    openaiTtsEndpoint: '',
    openaiTtsApiKey: '',
    openaiTtsModel: 'tts-1',
    openaiTtsVoice: 'alloy',
    openaiTtsFormat: 'mp3',
    openaiTtsSpeed: 1.0,
    enableVoiceCache: false,
    voiceCacheDir: 'voice-cache',
    voiceCacheMaxSizeMB: 100,

    // ============================================================
    // NOTIFICATION MODE & TTS REMINDER SETTINGS
    // ============================================================
    // 'sound-first' - Play sound immediately, TTS reminder after delay (default)
    // 'tts-first'   - Speak TTS immediately, no sound
    // 'both'        - Play sound AND speak TTS immediately
    // 'sound-only'  - Only play sound, no TTS at all
    notificationMode: 'sound-first',

    // Enable TTS reminder if user doesn't respond after sound notification
    enableTTSReminder: true,

    // Delay in seconds before TTS reminder (if user hasn't responded)
    // Can be set globally or per-notification type
    ttsReminderDelaySeconds: 30,
    idleReminderDelaySeconds: 30,
    permissionReminderDelaySeconds: 20,

    // Follow-up reminders (if user still doesn't respond after first TTS)
    enableFollowUpReminders: true,
    maxFollowUpReminders: 3,
    reminderBackoffMultiplier: 1.5, // Each follow-up waits longer (30s, 45s, 67.5s)

    // ============================================================
    // TTS MESSAGE VARIETY (Initial notifications - randomly selected)
    // ============================================================
    // Messages when agent finishes work
    idleTTSMessages: [
      'All done! Your task has been completed successfully.',
      'Hey there! I finished working on your request.',
      'Task complete! Ready for your review whenever you are.',
      'Good news! Everything is done and ready for you.',
      'Finished! Let me know if you need anything else.',
    ],
    // Messages for permission requests
    permissionTTSMessages: [
      'Attention please! I need your permission to continue.',
      'Hey! Quick approval needed to proceed with the task.',
      'Heads up! There is a permission request waiting for you.',
      'Excuse me! I need your authorization before I can continue.',
      'Permission required! Please review and approve when ready.',
    ],
    // Messages for MULTIPLE permission requests (use {count} placeholder)
    permissionTTSMessagesMultiple: [
      'Attention please! There are {count} permission requests waiting for your approval.',
      'Hey! {count} permissions need your approval to continue.',
      'Heads up! You have {count} pending permission requests.',
      'Excuse me! I need your authorization for {count} different actions.',
      '{count} permissions required! Please review and approve when ready.',
    ],

    // ============================================================
    // TTS REMINDER MESSAGES (More urgent/personalized - used after delay)
    // ============================================================
    // Reminder messages when agent finished but user hasn't responded
    idleReminderTTSMessages: [
      'Hey, are you still there? Your task has been waiting for review.',
      'Just a gentle reminder - I finished your request a while ago!',
      'Hello? I completed your task. Please take a look when you can.',
      'Still waiting for you! The work is done and ready for review.',
      'Knock knock! Your completed task is patiently waiting for you.',
    ],
    // Reminder messages when permission still needed
    permissionReminderTTSMessages: [
      'Hey! I still need your permission to continue. Please respond!',
      'Reminder: There is a pending permission request. I cannot proceed without you.',
      'Hello? I am waiting for your approval. This is getting urgent!',
      'Please check your screen! I really need your permission to move forward.',
      'Still waiting for authorization! The task is on hold until you respond.',
    ],
    // Reminder messages for MULTIPLE permissions (use {count} placeholder)
    permissionReminderTTSMessagesMultiple: [
      'Hey! I still need your approval for {count} permissions. Please respond!',
      'Reminder: There are {count} pending permission requests. I cannot proceed without you.',
      'Hello? I am waiting for your approval on {count} items. This is getting urgent!',
      'Please check your screen! {count} permissions are waiting for your response.',
      'Still waiting for authorization on {count} requests! The task is on hold.',
    ],

    // Permission batch window (ms) - how long to wait for more permissions before notifying
    permissionBatchWindowMs: 800,

    // ============================================================
    // QUESTION TOOL MESSAGES (SDK v1.1.7+ - Agent asking user questions)
    // ============================================================
    // Messages when agent asks user a question
    questionTTSMessages: [
      'Hey! I have a question for you. Please check your screen.',
      'Attention! I need your input to continue.',
      'Quick question! Please take a look when you have a moment.',
      'I need some clarification. Could you please respond?',
      'Question time! Your input is needed to proceed.',
    ],
    // Messages for MULTIPLE questions (use {count} placeholder)
    questionTTSMessagesMultiple: [
      'Hey! I have {count} questions for you. Please check your screen.',
      'Attention! I need your input on {count} items to continue.',
      '{count} questions need your attention. Please take a look!',
      'I need some clarifications. There are {count} questions waiting for you.',
      'Question time! {count} questions need your response to proceed.',
    ],
    // Reminder messages for questions
    questionReminderTTSMessages: [
      'Hey! I am still waiting for your answer. Please check the questions!',
      'Reminder: There is a question waiting for your response.',
      'Hello? I need your input to continue. Please respond when you can.',
      'Still waiting for your answer! The task is on hold.',
      'Your input is needed! Please check the pending question.',
    ],
    // Reminder messages for MULTIPLE questions (use {count} placeholder)
    questionReminderTTSMessagesMultiple: [
      'Hey! I am still waiting for answers to {count} questions. Please respond!',
      'Reminder: There are {count} questions waiting for your response.',
      'Hello? I need your input on {count} items. Please respond when you can.',
      'Still waiting for your answers on {count} questions! The task is on hold.',
      'Your input is needed! {count} questions are pending your response.',
    ],
    // Question reminder delay (seconds) - slightly less urgent than permissions
    questionReminderDelaySeconds: 25,
    // Question batch window (ms) - how long to wait for more questions before notifying
    questionBatchWindowMs: 800,

    // ============================================================
    // SOUND FILES (Used for immediate notifications)
    // ============================================================
    idleSound: 'assets/Soft-high-tech-notification-sound-effect.mp3',
    permissionSound: 'assets/Machine-alert-beep-sound-effect.mp3',
    questionSound: 'assets/Machine-alert-beep-sound-effect.mp3',

    // ============================================================
    // GENERAL SETTINGS
    // ============================================================
    wakeMonitor: true,
    forceVolume: true,
    enableSound: true,
    enableToast: true,
    volumeThreshold: 50,
    idleThresholdSeconds: 30,
    debugLog: false,
  });
};

let elevenLabsQuotaExceeded = false;

/**
 * Creates a TTS utility instance
 * @param params - { $, client }
 * @returns TTS API
 */
export const createTTS = ({ $, client }: TTSFactoryParams): TTSAPI => {
  const shell: ShellRunner | undefined = $;
  const opencodeClient: OpenCodeClient | undefined = client;
  const config = getTTSConfig();
  const currentPlatform = getPlatform();
  const configDir = getConfigDir();
  const logsDir = path.join(configDir, 'logs');

  const logFile = path.join(logsDir, 'smart-voice-notify-debug.log');

  // Ensure logs directory exists if debug logging is enabled
  if (config.debugLog && !fs.existsSync(logsDir)) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
      // Silently fail - logging is optional
    }
  }

  // Debug logging function (defined early so it can be passed to Linux platform)
  const debugLog = (message: string): void => {
    if (!config.debugLog) return;
    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    } catch {}
  };

  // Initialize Linux platform utilities (only used on Linux)
  const linux: LinuxPlatformAPI | null = currentPlatform === 'linux' ? createLinuxPlatform({ $: shell, debugLog }) : null;
  let tuiShowToastShape: 'v1' | 'v2' | null = null;

  const showToast = async (message: string, variant: ToastVariant = 'info'): Promise<void> => {
    if (!config.enableToast) return;
    try {
      if (typeof opencodeClient?.tui?.showToast === 'function') {
        const toastPayload: TUIToastPayload = { message, variant, duration: 6000 };

        if (tuiShowToastShape === 'v1') {
          await opencodeClient.tui.showToast({ body: toastPayload });
          return;
        }

        if (tuiShowToastShape === 'v2') {
          await opencodeClient.tui.showToast(toastPayload);
          return;
        }

        try {
          await opencodeClient.tui.showToast(toastPayload);
          tuiShowToastShape = 'v2';
        } catch {
          await opencodeClient.tui.showToast({ body: toastPayload });
          tuiShowToastShape = 'v1';
        }
      }
    } catch {}
  };

  /**
   * Run a PowerShell script and throw on failure.
   *
   * Scripts are handed straight to `powershell.exe` as a single `-Command`
   * argument instead of being interpolated into a shell command string.  A
   * shell round-trip mangles the embedded quotes, here-strings and newlines of
   * these snippets, which produced
   * `The string is missing the terminator: ".` and silently killed playback.
   */
  const runPowerShellCommand = async (cmd: string): Promise<void> => {
    const result = await runPowerShellScript(cmd);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(detail);
    }
  };

  /** Run a PowerShell script and return stdout, ignoring failures. */
  const runPowerShellProbe = async (cmd: string): Promise<string> => {
    const result = await runPowerShellScript(cmd);
    if (result.exitCode !== 0) {
      debugLog(`PowerShell probe failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    return result.stdout.trim();
  };

  const escapePowerShellSingleQuotedString = (value: string): string => value.replace(/'/g, "''");

  const getSafeLoopCount = (value: number): number => {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(1, Math.floor(value));
  };

  // ============================================================
  // Windows audio backends
  // ============================================================
  //
  // Windows has no single reliable way to play an arbitrary audio file:
  //
  //   * WPF `MediaPlayer` and MCI both sit on top of Media Foundation, so on a
  //     machine without the audio codecs registered (Server Core, N-editions,
  //     some VM images) they fail — `MediaPlayer.NaturalDuration` never resolves
  //     and `mciSendString('open ...')` returns 277 / MCIERR_UNIMPL_SPECIFIED.
  //     `mciSendString('list all devices')` returns nothing at all.
  //   * `SoundPlayer` plays uncompressed WAV only.
  //   * `ffplay` ships its own decoders, so it works on a codec-less box.
  //   * Handing the file to the shell (the user's default media player) is the
  //     last resort and works as long as *some* player is installed.
  //
  // So the plugin walks an ordered chain instead of hard-coding one backend.
  // Each backend returns a PowerShell script, or `null` when it is unavailable
  // (which is checked before spawning anything, so the chain stays cheap).

  const findExecutableOnPath = (name: string): string | null => {
    const extensions =
      currentPlatform === 'win32'
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory.replace(/^"|"$/g, ''), `${name}${extension}`);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {
          // Unreadable PATH entry — keep looking.
        }
      }
    }
    return null;
  };

  const executableCache = new Map<string, string | null>();
  const findExecutableCached = (name: string): string | null => {
    if (!executableCache.has(name)) {
      executableCache.set(name, findExecutableOnPath(name));
    }
    return executableCache.get(name) ?? null;
  };

  /** WPF `MediaPlayer` — in-process and silent, but needs OS audio codecs. */
  const getWindowsDotnetPlaybackCommand = (audioPath: string, loopCount: number): string => {
    const safePath = escapePowerShellSingleQuotedString(audioPath);
    // NaturalDuration never resolves when a codec is missing, which used to
    // hang the `while` loop forever; it is now bounded by a short deadline
    // (a local file opens in well under a second when it is going to work).
    return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$filePath = (Resolve-Path '${safePath}').Path
$player.Open($filePath)
$deadline = (Get-Date).AddSeconds(5)
while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 50
}
if (-not $player.NaturalDuration.HasTimeSpan) {
    $player.Close()
    throw 'MediaPlayer could not determine the duration of the file (no MP3/AAC codec registered?)'
}
$durationMs = [int][Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 200
try {
  $player.Play()
  Start-Sleep -Milliseconds $durationMs

  for ($i = 1; $i -lt ${loopCount}; $i++) {
    $player.Position = [System.TimeSpan]::Zero
    $player.Play()
    Start-Sleep -Milliseconds $durationMs
  }
} finally {
  try { $player.Close() } catch {}
}
exit 0
`;
  };

  /** Legacy MCI — also codec-dependent, kept as a second in-process option. */
  const getWindowsMciPlaybackCommand = (audioPath: string, loopCount: number): string => {
    const safePath = escapePowerShellSingleQuotedString(audioPath);
    // The MCI command string is assembled with '+' concatenation instead of
    // PowerShell backtick-escaped quotes.  Backtick quoting is fragile and was
    // the direct cause of the "missing terminator" parse failure.
    return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MciAudio {
  [DllImport("winmm.dll", CharSet = CharSet.Auto)]
  public static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr winHandle);
}
'@
function Invoke-Mci([string]$Command) {
  $buffer = New-Object System.Text.StringBuilder 256
  $code = [MciAudio]::mciSendString($Command, $buffer, $buffer.Capacity, [IntPtr]::Zero)
  if ($code -ne 0) { throw "MCI command failed ($code): $Command" }
  return $buffer.ToString()
}
$filePath = '${safePath}'
$alias = 'opencode_notify_' + ([Guid]::NewGuid().ToString('N'))
try {
  for ($i = 0; $i -lt ${loopCount}; $i++) {
    [void](Invoke-Mci ('open "' + $filePath + '" alias ' + $alias))
    [void](Invoke-Mci ('play ' + $alias + ' wait'))
    [void](Invoke-Mci ('close ' + $alias))
  }
} finally {
  try { [void](Invoke-Mci ('close ' + $alias)) } catch {}
}
exit 0
`;
  };

  /** `ffplay` — bundles its own decoders, so it works without OS codecs. */
  const getWindowsFfplayPlaybackCommand = (audioPath: string, loopCount: number, ffplay: string): string => {
    const safePath = escapePowerShellSingleQuotedString(audioPath);
    // `-stream_loop` is missing from some ffplay builds, so repeat the process
    // instead of relying on it.
    return `
$ErrorActionPreference = 'Stop'
$player = '${escapePowerShellSingleQuotedString(ffplay)}'
if (-not (Test-Path -LiteralPath $player)) { throw "ffplay not found at $player" }
$filePath = '${safePath}'
for ($i = 0; $i -lt ${loopCount}; $i++) {
  & $player -nodisp -autoexit -loglevel quiet -loglevel error $filePath
  if ($LASTEXITCODE -ne 0) { throw "ffplay exited with code $LASTEXITCODE" }
}
exit 0
`;
  };

  /** `System.Media.SoundPlayer` — always available, but uncompressed WAV only. */
  const getWindowsSoundPlayerPlaybackCommand = (audioPath: string, loopCount: number): string => {
    const safePath = escapePowerShellSingleQuotedString(audioPath);
    return `
$ErrorActionPreference = 'Stop'
$player = New-Object System.Media.SoundPlayer
$player.Load('${safePath}')
for ($i = 0; $i -lt ${loopCount}; $i++) {
  $player.PlaySync()
}
$player.Dispose()
exit 0
`;
  };

  /**
   * Hand the file to the shell so it opens in the user's default media player.
   * Works even when Windows itself cannot decode the format.  It is
   * fire-and-forget: there is no reliable way to know when the external player
   * has finished, so `loopCount` is capped at a single launch.
   */
  const getWindowsShellPlaybackCommand = (audioPath: string): string => {
    const safePath = escapePowerShellSingleQuotedString(audioPath);
    return `
$ErrorActionPreference = 'Stop'
$filePath = (Resolve-Path '${safePath}').Path
Start-Process -FilePath $filePath
exit 0
`;
  };

  type WindowsAudioBackend = 'dotnet' | 'mci' | 'ffplay' | 'soundplayer' | 'shell';

  const DEFAULT_WINDOWS_BACKENDS: WindowsAudioBackend[] = ['dotnet', 'mci', 'ffplay', 'soundplayer', 'shell'];

  const configuredWindowsBackends = (): WindowsAudioBackend[] => {
    const configured = config.windowsAudioBackends;
    if (!Array.isArray(configured) || configured.length === 0) {
      return DEFAULT_WINDOWS_BACKENDS;
    }
    const known = new Set<string>(DEFAULT_WINDOWS_BACKENDS);
    const filtered = configured
      .map((entry) => String(entry).trim().toLowerCase())
      .filter((entry): entry is WindowsAudioBackend => known.has(entry));
    return filtered.length > 0 ? filtered : DEFAULT_WINDOWS_BACKENDS;
  };

  let ffplayPath: string | null | undefined;

  /**
   * Backends that recently failed are skipped for the rest of the process.
   *
   * A missing codec or a missing player does not fix itself between
   * notifications, and probing WPF `MediaPlayer` for its duration costs ~5s on
   * a codec-less machine — pure dead time before every single notification.
   * A backend becomes eligible again after {@link BACKEND_QUARANTINE_MS} so a
   * transient failure (a file that was still being written, say) heals.
   */
  const BACKEND_QUARANTINE_MS = 10 * 60_000;
  const backendQuarantine = new Map<WindowsAudioBackend, number>();

  const isBackendQuarantined = (backend: WindowsAudioBackend): boolean => {
    const failedAt = backendQuarantine.get(backend);
    if (failedAt === undefined) return false;
    if (Date.now() - failedAt > BACKEND_QUARANTINE_MS) {
      backendQuarantine.delete(backend);
      return false;
    }
    return true;
  };

  const quarantineBackend = (backend: WindowsAudioBackend): void => {
    backendQuarantine.set(backend, Date.now());
  };

  const clearBackendQuarantine = (backend: WindowsAudioBackend): void => {
    backendQuarantine.delete(backend);
  };

  interface WindowsPlaybackPlan {
    backend: WindowsAudioBackend;
    script: string;
  }

  /**
   * Build the ordered list of Windows playback attempts, skipping backends that
   * are not usable at all (so nothing is spawned only to fail immediately).
   */
  const getWindowsPlaybackPlans = (audioPath: string, loopCount: number): WindowsPlaybackPlan[] => {
    const plans: WindowsPlaybackPlan[] = [];
    const isWav = path.extname(audioPath).toLowerCase() === '.wav';

    for (const backend of configuredWindowsBackends()) {
      switch (backend) {
        case 'dotnet':
          plans.push({ backend, script: getWindowsDotnetPlaybackCommand(audioPath, loopCount) });
          break;
        case 'mci':
          plans.push({ backend, script: getWindowsMciPlaybackCommand(audioPath, loopCount) });
          break;
        case 'ffplay':
          if (ffplayPath === undefined) {
            ffplayPath = findExecutableCached('ffplay');
            debugLog(`playAudioFile: ffplay lookup -> ${ffplayPath ?? 'not found on PATH'}`);
          }
          if (ffplayPath) {
            plans.push({ backend, script: getWindowsFfplayPlaybackCommand(audioPath, loopCount, ffplayPath) });
          }
          break;
        case 'soundplayer':
          // SoundPlayer silently does nothing useful for compressed formats.
          if (isWav) {
            plans.push({ backend, script: getWindowsSoundPlayerPlaybackCommand(audioPath, loopCount) });
          }
          break;
        case 'shell':
          plans.push({ backend, script: getWindowsShellPlaybackCommand(audioPath) });
          break;
        default:
          break;
      }
    }

    return plans;
  };

  const playWindowsAudio = async (filePath: string, loopCount: number): Promise<void> => {
    const plans = getWindowsPlaybackPlans(filePath, loopCount);
    if (plans.length === 0) {
      throw new Error('no usable Windows audio backend is configured');
    }

    const failures: string[] = [];
    for (const plan of plans) {
      if (isBackendQuarantined(plan.backend)) {
        debugLog(`playAudioFile: skipping backend "${plan.backend}" (recently failed)`);
        failures.push(`${plan.backend}: skipped after an earlier failure`);
        continue;
      }

      debugLog(`playAudioFile: trying backend "${plan.backend}" for ${filePath} (${loopCount}x)`);
      try {
        await runPowerShellCommand(plan.script);
        clearBackendQuarantine(plan.backend);
        debugLog(`playAudioFile: Windows playback succeeded via "${plan.backend}" for ${filePath} (${loopCount}x)`);
        return;
      } catch (error) {
        const detail = (getErrorMessage(error).split('\n')[0] ?? '').trim();
        failures.push(`${plan.backend}: ${detail}`);
        quarantineBackend(plan.backend);
        debugLog(`playAudioFile: backend "${plan.backend}" failed — ${detail}`);
      }
    }

    throw new Error(failures.join(' | '));
  };

  /**
   * Play an audio file using system media player
   */
  const playAudioFile = async (filePath: string, loops = 1): Promise<void> => {
    const safeLoops = getSafeLoopCount(loops);
    try {
      if (currentPlatform === 'win32') {
        await playWindowsAudio(filePath, safeLoops);
        return;
      }

      if (currentPlatform === 'darwin') {
        if (!shell) {
          debugLog('playAudioFile: shell runner ($) not available for macOS playback');
          return;
        }
        for (let i = 0; i < safeLoops; i++) {
          await shell`afplay ${filePath}`.quiet();
        }
      } else if (currentPlatform === 'linux' && linux) {
        // Use the Linux platform module for audio playback
        await linux.playAudioFile(filePath, safeLoops);
      } else {
        if (!shell) {
          debugLog('playAudioFile: shell runner ($) not available for Unix playback');
          return;
        }
        // Generic fallback for other Unix-like systems
        for (let i = 0; i < safeLoops; i++) {
          try {
            await shell`paplay ${filePath}`.quiet();
          } catch {
            await shell`aplay ${filePath}`.quiet();
          }
        }
      }
    } catch (error) {
      debugLog(`playAudioFile error: ${getErrorMessage(error)}`);
    }
  };

  const getVoiceCacheLimitBytes = (): number => {
    const maxSizeMB = Number(config.voiceCacheMaxSizeMB ?? 100);
    if (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0) {
      return 0;
    }
    return Math.floor(maxSizeMB * 1024 * 1024);
  };

  const getVoiceCacheDirectory = (): string | null => {
    if (!config.enableVoiceCache || getVoiceCacheLimitBytes() <= 0) {
      return null;
    }

    const configuredDir = config.voiceCacheDir || 'voice-cache';
    const cacheDir = path.isAbsolute(configuredDir) ? configuredDir : path.join(configDir, configuredDir);

    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      return cacheDir;
    } catch (error) {
      debugLog(`voice cache: unable to create cache directory: ${getErrorMessage(error)}`);
      return null;
    }
  };

  const normalizeCacheExtension = (extension: string): string => {
    const cleaned = extension.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return cleaned || 'mp3';
  };

  const getVoiceCacheFile = (
    engine: VoiceCacheEngine,
    text: string,
    parameters: Record<string, unknown>,
    extension: string,
  ): string | null => {
    const cacheDir = getVoiceCacheDirectory();
    if (!cacheDir) {
      return null;
    }

    const cacheKey = crypto
      .createHash('sha256')
      .update(JSON.stringify({ version: 1, engine, text, parameters }))
      .digest('hex');

    return path.join(cacheDir, `tts-${cacheKey}.${normalizeCacheExtension(extension)}`);
  };

  const pruneVoiceCache = (cacheDir: string): void => {
    const limitBytes = getVoiceCacheLimitBytes();
    if (limitBytes <= 0) {
      return;
    }

    try {
      const entries = fs
        .readdirSync(cacheDir)
        .filter((file) => file.startsWith('tts-'))
        .map((file) => {
          const filePath = path.join(cacheDir, file);
          const stats = fs.statSync(filePath);
          return { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
        })
        .filter((entry) => fs.statSync(entry.filePath).isFile())
        .sort((left, right) => left.mtimeMs - right.mtimeMs);

      let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
      for (const entry of entries) {
        if (totalBytes <= limitBytes) {
          break;
        }
        try {
          fs.unlinkSync(entry.filePath);
          totalBytes -= entry.size;
        } catch (error) {
          debugLog(`voice cache: unable to prune ${entry.filePath}: ${getErrorMessage(error)}`);
        }
      }
    } catch (error) {
      debugLog(`voice cache: prune failed: ${getErrorMessage(error)}`);
    }
  };

  const commitVoiceCacheFile = (tempFile: string, cacheFile: string): boolean => {
    try {
      if (!fs.existsSync(tempFile)) {
        return false;
      }

      if (fs.existsSync(cacheFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
        return true;
      }

      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      try {
        fs.renameSync(tempFile, cacheFile);
      } catch {
        fs.copyFileSync(tempFile, cacheFile);
        fs.unlinkSync(tempFile);
      }
      pruneVoiceCache(path.dirname(cacheFile));
      return fs.existsSync(cacheFile);
    } catch (error) {
      debugLog(`voice cache: unable to commit cache file: ${getErrorMessage(error)}`);
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
      return false;
    }
  };

  const writeVoiceCacheBuffer = (cacheFile: string, audio: Buffer): boolean => {
    const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempFile, audio);
      return commitVoiceCacheFile(tempFile, cacheFile);
    } catch (error) {
      debugLog(`voice cache: unable to write cache buffer: ${getErrorMessage(error)}`);
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
      return false;
    }
  };

  const copyVoiceCacheFile = (cacheFile: string, sourceFile: string): boolean => {
    if (!fs.existsSync(sourceFile)) {
      return false;
    }

    const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.copyFileSync(sourceFile, tempFile);
      return commitVoiceCacheFile(tempFile, cacheFile);
    } catch (error) {
      debugLog(`voice cache: unable to copy cache file: ${getErrorMessage(error)}`);
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
      return false;
    }
  };

  const playCachedVoiceFile = async (cacheFile: string): Promise<boolean> => {
    if (!fs.existsSync(cacheFile)) {
      return false;
    }

    try {
      const now = new Date();
      fs.utimesSync(cacheFile, now, now);
    } catch {}

    debugLog(`voice cache: hit ${cacheFile}`);
    await playAudioFile(cacheFile);
    return true;
  };

  const createTempAudioFile = (prefix: string, extension: string): string => {
    const uniquePart = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return path.join(os.tmpdir(), `${prefix}-${uniquePart}.${normalizeCacheExtension(extension)}`);
  };

  /**
   * ElevenLabs Engine (Online, High Quality, Anime-like voices)
   */
  const speakWithElevenLabs = async (text: string): Promise<boolean> => {
    const voiceId = config.elevenLabsVoiceId || 'cgSgspJ2msm6clMCkdW9';
    const model = config.elevenLabsModel || 'eleven_turbo_v2_5';
    const stability = config.elevenLabsStability ?? 0.5;
    const similarity = config.elevenLabsSimilarity ?? 0.75;
    const style = config.elevenLabsStyle ?? 0.5;
    const cacheFile = getVoiceCacheFile(
      'elevenlabs',
      text,
      { voiceId, model, stability, similarity, style },
      'mp3',
    );

    if (cacheFile && (await playCachedVoiceFile(cacheFile))) {
      return true;
    }

    if (elevenLabsQuotaExceeded) return false;

    if (!config.elevenLabsApiKey) {
      debugLog('speakWithElevenLabs: No API key configured');
      return false;
    }

    try {
      const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
      const elClient = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });

      const elevenLabsPayload = {
        text,
        model_id: model,
        voice_settings: {
          stability,
          similarity_boost: similarity,
          style,
          use_speaker_boost: true,
        },
      } as unknown as Parameters<typeof elClient.textToSpeech.convert>[1];

      const audio = await elClient.textToSpeech.convert(voiceId, elevenLabsPayload);

      const chunks: Buffer[] = [];
      for await (const chunk of audio as AsyncIterable<unknown>) {
        chunks.push(toBufferChunk(chunk));
      }
      const audioBuffer = Buffer.concat(chunks);
      const cacheWritten = cacheFile ? writeVoiceCacheBuffer(cacheFile, audioBuffer) : false;
      const audioFile = cacheWritten && cacheFile ? cacheFile : createTempAudioFile('opencode-tts', 'mp3');
      if (!cacheWritten) {
        fs.writeFileSync(audioFile, audioBuffer);
      }

      await playAudioFile(audioFile);
      if (!cacheWritten) {
        try {
          fs.unlinkSync(audioFile);
        } catch {}
      }
      return true;
    } catch (error) {
      debugLog(`speakWithElevenLabs error: ${getErrorMessage(error) || String(error) || 'Unknown error'}`);

      // Handle quota exceeded (401 specifically, or specific error message)
      const elevenLabsError = error as ElevenLabsErrorLike;
      const errorMessage = elevenLabsError.message ?? '';
      const isQuotaError =
        elevenLabsError.statusCode === 401 ||
        errorMessage.includes('401') ||
        errorMessage.toLowerCase().includes('quota_exceeded') ||
        errorMessage.toLowerCase().includes('quota exceeded');

      if (isQuotaError) {
        elevenLabsQuotaExceeded = true;
        await showToast('⚠️ ElevenLabs quota exceeded! Switching to Edge TTS for this session.', 'error');
      }

      return false;
    }
  };

  /**
   * Edge TTS Engine via Python CLI (Free, Neural voices)
   * Uses Python edge-tts package via command line as it's more reliable than Node.js WebSocket libraries.
   * Fallback: tries msedge-tts npm package if Python edge-tts is not available.
   */
  const speakWithEdgeTTS = async (text: string): Promise<boolean> => {
    const voice = config.edgeVoice || 'en-US-JennyNeural';
    const pitch = config.edgePitch || '+0Hz';
    const rate = config.edgeRate || '+10%';
    const volume = config.edgeVolume || '+0%';
    const cacheFile = getVoiceCacheFile('edge', text, { voice, pitch, rate, volume }, 'mp3');

    if (cacheFile && (await playCachedVoiceFile(cacheFile))) {
      return true;
    }

    const tempFile = cacheFile ? `${cacheFile}.${process.pid}.${Date.now()}.tmp` : createTempAudioFile('opencode-edge-tts', 'mp3');

    // Try Python edge-tts first (more reliable due to aiohttp WebSocket handling)
    if (shell) {
      try {
        // The shell runner quotes interpolated values for us; pre-escaping the
        // text here would corrupt it (it turned "done" into \"done\" and made
        // the CLI write no file at all).
        const result = await shell`edge-tts --voice ${voice} --rate ${rate} --volume ${volume} --pitch ${pitch} --text ${text} --write-media ${tempFile}`
          .quiet()
          .nothrow();

        if (fs.existsSync(tempFile)) {
          const cacheWritten = cacheFile ? commitVoiceCacheFile(tempFile, cacheFile) : false;
          const audioFile = cacheWritten && cacheFile ? cacheFile : tempFile;
          await playAudioFile(audioFile);
          if (!cacheWritten) {
            try {
              fs.unlinkSync(tempFile);
            } catch {}
          }
          debugLog('speakWithEdgeTTS: success via Python edge-tts CLI');
          return true;
        }

        // No output file — surface why, instead of silently falling through to
        // the npm package (this used to look like an unexplained WebSocket
        // failure several lines later).
        debugLog(
          `speakWithEdgeTTS: Python CLI produced no audio (exit=${result.exitCode}, stderr=${outputToString(result.stderr).trim().slice(0, 300) || 'empty'}), trying npm package...`,
        );
      } catch (error) {
        debugLog(`speakWithEdgeTTS: Python CLI failed: ${getErrorMessage(error) || 'unknown'}, trying npm package...`);
        // Fall through to try npm package
      }
    }

    // Fallback to msedge-tts npm package
    try {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');

      // The Edge WebSocket handshake fails intermittently ("Expected 101 status
      // code") under load or right after a burst of other requests.  One short
      // retry turns most of those into a success instead of a silent fallthrough
      // to the offline engines.
      const synthesizeWithMsEdgeTts = async (): Promise<string> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const tts = new MsEdgeTTS();
          try {
            await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
            const { audioFilePath } = await tts.toFile(os.tmpdir(), text, { pitch, rate, volume });
            return audioFilePath;
          } catch (error) {
            lastError = error;
            if (attempt === 1) {
              debugLog(`speakWithEdgeTTS: msedge-tts attempt 1 failed (${getErrorMessage(error) || 'unknown'}), retrying…`);
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }
        throw lastError;
      };

      const audioFilePath = await synthesizeWithMsEdgeTts();

      const cacheWritten = cacheFile ? copyVoiceCacheFile(cacheFile, audioFilePath) : false;
      const audioFile = cacheWritten && cacheFile ? cacheFile : audioFilePath;
      await playAudioFile(audioFile);
      try {
        if (audioFilePath !== audioFile) {
          fs.unlinkSync(audioFilePath);
        } else if (!cacheWritten) {
          fs.unlinkSync(audioFilePath);
        }
      } catch {}
      debugLog('speakWithEdgeTTS: success via msedge-tts npm package');
      return true;
    } catch (error) {
      debugLog(`speakWithEdgeTTS error: ${getErrorMessage(error) || String(error) || 'Unknown error'}`);
      return false;
    }
  };

  /**
   * Windows SAPI Engine (Offline, Built-in)
   */
  const speakWithSAPI = async (text: string): Promise<boolean> => {
    if (currentPlatform !== 'win32') {
      debugLog('speakWithSAPI: skipped (not Windows)');
      return false;
    }
    let sapiOutputFile: string | null = null;
    try {
      const escapedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      const voice = config.sapiVoice || 'Microsoft Zira Desktop';
      const rate = Math.max(-10, Math.min(10, config.sapiRate || -1));
      const pitch = config.sapiPitch || 'medium';
      const volume = config.sapiVolume || 'loud';
      const ratePercent = rate >= 0 ? `+${rate * 10}%` : `${rate * 5}%`;
      const cacheFile = getVoiceCacheFile('sapi', text, { voice, rate, pitch, volume }, 'wav');

      if (cacheFile && (await playCachedVoiceFile(cacheFile))) {
        return true;
      }

      // Always render to a WAV file rather than letting SAPI talk to the default
      // audio device.  Desktop voices route through the audio stack, so on a
      // machine with no default output (or no audio codecs) SAPI fails with
      // "Audio device error encountered - Error Code: 0x2" and says nothing at
      // all.  Rendering to a file and handing it to playAudioFile keeps SAPI a
      // pure synthesizer and lets the Windows backend chain decide playback.
      sapiOutputFile = cacheFile
        ? `${cacheFile}.${process.pid}.${Date.now()}.tmp.wav`
        : createTempAudioFile('opencode-sapi', 'wav');
      const setOutputToWaveFile = `$synth.SetOutputToWaveFile('${sapiOutputFile.replace(/'/g, "''")}')`;

      const ssml = `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <voice name="${voice.replace(/"/g, '&quot;')}">
    <prosody rate="${ratePercent}" pitch="${pitch}" volume="${volume}">
      ${escapedText}
    </prosody>
  </voice>
</speak>`;

      const scriptContent = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.Rate = ${rate}
    try { $synth.SelectVoice("${voice.replace(/"/g, '""')}") } catch { }
    ${setOutputToWaveFile}
    $ssml = @"
${ssml}
"@
    $synth.SpeakSsml($ssml)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($synth) { $synth.Dispose() }
}
`;
      // The script is executed via runPowerShellScript rather than being written
      // to disk and passed as `-File <path>`: the path used to be interpolated
      // into a shell command string, where the quoting mangled it.
      const result = await runPowerShellScript(scriptContent);

      if (result.exitCode !== 0) {
        debugLog(`speakWithSAPI failed with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
        return false;
      }

      if (!fs.existsSync(sapiOutputFile)) {
        debugLog('speakWithSAPI: SAPI reported success but wrote no wave file');
        return false;
      }

      // Promote the temp render into the cache when caching is enabled, then
      // play whichever file won.
      let audioFile = sapiOutputFile;
      if (cacheFile && commitVoiceCacheFile(sapiOutputFile, cacheFile)) {
        audioFile = cacheFile;
      }
      await playAudioFile(audioFile);
      return true;
    } catch (error) {
      debugLog(`speakWithSAPI error: ${getErrorMessage(error) || String(error) || 'Unknown error'}`);
      return false;
    } finally {
      try {
        if (sapiOutputFile && fs.existsSync(sapiOutputFile)) fs.unlinkSync(sapiOutputFile);
      } catch {}
    }
  };

  /**
   * macOS Say Engine
   */
  const speakWithSay = async (text: string): Promise<boolean> => {
    if (currentPlatform !== 'darwin' || !shell) return false;
    try {
      await shell`say ${text}`.quiet();
      return true;
    } catch (error) {
      debugLog(`speakWithSay error: ${getErrorMessage(error) || String(error) || 'Unknown error'}`);
      return false;
    }
  };

  /**
   * OpenAI-Compatible TTS Engine (Kokoro, OpenAI, LocalAI, etc.)
   * Calls /v1/audio/speech endpoint with configurable base URL
   */
  const speakWithOpenAI = async (text: string): Promise<boolean> => {
    const endpoint = config.openaiTtsEndpoint.replace(/\/$/, '');
    const model = config.openaiTtsModel || 'tts-1';
    const voice = config.openaiTtsVoice || 'alloy';
    const format = config.openaiTtsFormat || 'mp3';
    const speed = config.openaiTtsSpeed ?? 1.0;
    const cacheFile = getVoiceCacheFile('openai', text, { endpoint, model, voice, format, speed }, format);

    if (cacheFile && (await playCachedVoiceFile(cacheFile))) {
      return true;
    }

    if (!endpoint) {
      debugLog('speakWithOpenAI: No endpoint configured');
      return false;
    }

    try {
      const url = `${endpoint}/v1/audio/speech`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add auth header if API key is provided
      if (config.openaiTtsApiKey) {
        headers.Authorization = `Bearer ${config.openaiTtsApiKey}`;
      }

      const body = {
        model,
        input: text,
        voice,
        response_format: format,
        speed,
      };

      debugLog(`speakWithOpenAI: Calling ${url} with voice=${body.voice}, model=${body.model}`);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        debugLog(`speakWithOpenAI: API error ${response.status}: ${errorText}`);
        return false;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const cacheWritten = cacheFile ? writeVoiceCacheBuffer(cacheFile, audioBuffer) : false;
      const audioFile = cacheWritten && cacheFile ? cacheFile : createTempAudioFile('opencode-tts-openai', format);
      if (!cacheWritten) {
        fs.writeFileSync(audioFile, audioBuffer);
      }

      await playAudioFile(audioFile);
      if (!cacheWritten) {
        try {
          fs.unlinkSync(audioFile);
        } catch {}
      }
      return true;
    } catch (error) {
      debugLog(`speakWithOpenAI error: ${getErrorMessage(error) || String(error) || 'Unknown error'}`);
      return false;
    }
  };

  /**
   * Get the current system idle time in seconds.
   */
  const getSystemIdleSeconds = async (): Promise<number> => {
    if (currentPlatform === 'linux') {
      // On Linux, we can't reliably detect idle time across all DEs
      // Return a high value to always attempt wake (it's a no-op if already awake)
      return 999;
    }
    if (currentPlatform !== 'win32' || !shell) return 999;
    try {
      const cmd = `
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdleCheck {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint GetIdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(lii);
        if (GetLastInputInfo(ref lii)) {
            return (uint)((Environment.TickCount - lii.dwTime) / 1000);
        }
        return 0;
    }
}
'@
[IdleCheck]::GetIdleSeconds()
      `;
      return parseInt(await runPowerShellProbe(cmd) || '0', 10);
    } catch {
      return 999; // Assume idle on error
    }
  };

  /**
   * Get the current system volume level (0-100).
   */
  const getCurrentVolume = async (): Promise<number> => {
    // Use Linux platform module
    if (currentPlatform === 'linux' && linux) {
      return await linux.getCurrentVolume();
    }
    if (currentPlatform !== 'win32' || !shell) return -1;
    try {
      const cmd = `
        $signature = @'
[DllImport("winmm.dll")]
public static extern int waveOutGetVolume(IntPtr hwo, out uint dwVolume);
'@
        Add-Type -MemberDefinition $signature -Name Win32VolCheck -Namespace Win32 -PassThru | Out-Null
        $vol = 0
        $result = [Win32.Win32VolCheck]::waveOutGetVolume([IntPtr]::Zero, [ref]$vol)
        if ($result -eq 0) {
            $leftVol = $vol -band 0xFFFF
            [Math]::Round(($leftVol / 65535) * 100)
        } else { -1 }
      `;
      return parseInt(await runPowerShellProbe(cmd) || '-1', 10);
    } catch {
      return -1;
    }
  };

  /**
   * Wake Monitor Utility
   */
  const wakeMonitor = async (force = false): Promise<void> => {
    if (!config.wakeMonitor) return;
    try {
      const idleSeconds = await getSystemIdleSeconds();
      const threshold = config.idleThresholdSeconds || 30;

      if (!force && idleSeconds < threshold) {
        debugLog(`wakeMonitor: skipped (idle ${idleSeconds}s < ${threshold}s)`);
        return;
      }

      debugLog(`wakeMonitor: attempting to wake monitor (idle: ${idleSeconds}s, force: ${force})`);

      if (currentPlatform === 'win32') {
        const cmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F15}')`;
        await runPowerShellCommand(cmd);
        debugLog('wakeMonitor: Windows wake command executed');
      } else if (currentPlatform === 'darwin' && shell) {
        await shell`caffeinate -u -t 1`.quiet();
        debugLog('wakeMonitor: macOS wake command executed');
      } else if (currentPlatform === 'linux' && linux) {
        // Use the Linux platform module for wake monitor
        await linux.wakeMonitor();
        debugLog('wakeMonitor: Linux wake command executed');
      }
    } catch (error) {
      debugLog(`wakeMonitor error: ${getErrorMessage(error)}`);
    }
  };

  /**
   * Force Volume Utility
   */
  const forceVolume = async (force = false): Promise<void> => {
    if (!config.forceVolume) return;
    if (currentPlatform === 'win32') {
      // handled entirely through PowerShell below
    } else if (!shell) {
      return;
    }
    try {
      if (!force) {
        const currentVolume = await getCurrentVolume();
        const volumeThreshold = config.volumeThreshold || 50;
        if (currentVolume >= 0 && currentVolume >= volumeThreshold) return;
      }

      if (currentPlatform === 'win32') {
        const cmd = `$wsh = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $wsh.SendKeys([char]175) }`;
        await runPowerShellCommand(cmd);
      } else if (currentPlatform === 'darwin' && shell) {
        await shell`osascript -e "set volume output volume 100"`.quiet();
      } else if (currentPlatform === 'linux' && linux) {
        // Use the Linux platform module for force volume
        await linux.forceVolume();
      }
    } catch (error) {
      debugLog(`forceVolume error: ${getErrorMessage(error)}`);
    }
  };

  /**
   * Main Speak function with fallback chain
   * Cascade: Primary Engine -> Edge TTS -> Windows SAPI -> macOS Say -> Sound File
   *
   * Fallback ensures TTS works even if:
   * - Python edge-tts not installed (falls to npm package, then SAPI/Say)
   * - msedge-tts npm fails (403 errors - falls to SAPI/Say)
   * - User is on macOS without edge-tts (falls to built-in 'say' command)
   * - User is on Linux without edge-tts (falls to sound file only)
   */
  const speak = async (message: string, options: SpeakOptions = {}): Promise<boolean> => {
    const activeConfig = { ...config, ...options } as PluginConfig & SpeakOptions;
    if (!activeConfig.enableSound) return false;

    if (activeConfig.enableTTS) {
      let success = false;
      const engine = activeConfig.ttsEngine || 'elevenlabs';

      if (engine === 'openai') {
        success = await speakWithOpenAI(message);
        if (!success) success = await speakWithEdgeTTS(message);
        if (!success) success = await speakWithSAPI(message);
        if (!success) success = await speakWithSay(message); // macOS fallback
      } else if (engine === 'elevenlabs') {
        success = await speakWithElevenLabs(message);
        if (!success) success = await speakWithEdgeTTS(message);
        if (!success) success = await speakWithSAPI(message);
        if (!success) success = await speakWithSay(message); // macOS fallback
      } else if (engine === 'edge') {
        success = await speakWithEdgeTTS(message);
        if (!success) success = await speakWithSAPI(message);
        if (!success) success = await speakWithSay(message); // macOS fallback
      } else if (engine === 'sapi') {
        success = await speakWithSAPI(message);
        if (!success) success = await speakWithSay(message);
      }

      if (success) return true;
    }

    if (activeConfig.fallbackSound) {
      const soundPath = path.isAbsolute(activeConfig.fallbackSound)
        ? activeConfig.fallbackSound
        : path.join(getConfigDir(), activeConfig.fallbackSound);

      await playAudioFile(soundPath, activeConfig.loops || 1);
    }
    return false;
  };

  return {
    speak,
    announce: async (message: string, options: SpeakOptions = {}): Promise<boolean> => {
      await wakeMonitor();
      await forceVolume();
      return speak(message, options);
    },
    wakeMonitor,
    forceVolume,
    playAudioFile,
    config,
  };
};
