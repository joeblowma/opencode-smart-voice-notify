/**
 * OpenCode V2 adapter for Smart Voice Notify.
 *
 * OpenCode V2 (>= 2.0.x) loads plugins through `@opencode/plugin` and expects a
 * default export shaped as `{ id, setup }` (see `Plugin.define`). The V2 plugin
 * `Context` is very different from the legacy V1 `PluginInput`:
 *
 *   - There is NO `$` shell runner.  We synthesise one on top of
 *     `node:child_process` so the existing audio / TTS / volume helpers keep
 *     working.
 *   - There is NO `client.tui.showToast` and no raw `client` object.  We provide
 *     a thin shim that maps session lookups to `ctx.session.get` and turns
 *     toasts into best-effort no-ops (V2 exposes no plugin-facing toast API).
 *   - Events arrive from `ctx.event.subscribe()` as `{ type, data, created, ... }`
 *     whereas the V1 handler consumes `{ type, properties }`.  We translate V2
 *     events into the V1 shape so the battle-tested notification logic in
 *     `plugin.ts` can be reused verbatim.
 *
 * The V1 implementation is preserved untouched and re-exported as `server` on
 * the package entry point so OpenCode V1 (1.18.29+) keeps working too.
 */

import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

import { Plugin } from '@opencode/plugin';

import { SmartVoiceNotifyPlugin } from './plugin.js';
import type { OpenCodeClient, PluginEvent, SessionGetResult, ShellExecution, ShellResult, ShellRunner } from './types/opencode-sdk.js';

/** Stable plugin identifier reported to OpenCode V2. */
export const PLUGIN_ID = 'smart-voice-notify';

/** Minimal shape of the V2 event envelope we consume. */
interface V2EventEnvelope {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string; workspaceID?: string };
  data?: Record<string, unknown>;
}

// ============================================================
// Cross-instance event de-duplication
// ============================================================

/**
 * OpenCode V2 instantiates a server plugin once per location (project
 * directory), yet every instance shares a single process-wide event stream
 * (`ctx.event.subscribe()` maps to `GET /api/event`).  Without a guard each
 * instance reacts to every event, so a single notification is spoken once per
 * loaded location — heard by the user as overlapping / echoing audio.
 *
 * We therefore remember the unique id of each event in a process-wide registry
 * (stored on `globalThis` so it survives module re-evaluation and is shared by
 * every instance) and let only the first instance to observe an event act on
 * it.  Distinct events keep distinct ids, so genuine concurrent notifications
 * are unaffected.
 */
const PROCESSED_EVENT_TTL_MS = 15_000;
const PROCESSED_EVENT_MAX = 1024;
const PROCESSED_EVENTS_KEY = Symbol.for('opencode-smart-voice-notify.processed-events');

interface ProcessedEventRegistry {
  seen: Map<string, number>;
}

const getProcessedEventRegistry = (): ProcessedEventRegistry => {
  const globalStore = globalThis as unknown as Record<symbol, ProcessedEventRegistry | undefined>;
  let registry = globalStore[PROCESSED_EVENTS_KEY];
  if (!registry) {
    registry = { seen: new Map<string, number>() };
    globalStore[PROCESSED_EVENTS_KEY] = registry;
  }
  return registry;
};

/**
 * Record an event id and report whether it had already been handled.
 * Returns `false` (i.e. "not a duplicate") when the id is missing so that an
 * id-less event is never silently dropped.
 */
export const isDuplicateEvent = (eventId: string | undefined): boolean => {
  if (!eventId) return false;

  const registry = getProcessedEventRegistry();
  const now = Date.now();

  if (registry.seen.size >= PROCESSED_EVENT_MAX) {
    for (const [id, timestamp] of registry.seen) {
      if (now - timestamp > PROCESSED_EVENT_TTL_MS) {
        registry.seen.delete(id);
      }
    }
  }

  const previous = registry.seen.get(eventId);
  if (previous !== undefined && now - previous <= PROCESSED_EVENT_TTL_MS) {
    return true;
  }

  registry.seen.set(eventId, now);
  return false;
};

// ============================================================
// Session -> location routing
// ============================================================

/**
 * Some V2 events that we must act on carry no `location` (notably
 * `session.execution.succeeded` / `session.execution.failed`), yet the plugin
 * is loaded once per location and must only react to sessions that belong to
 * its own location.  We therefore remember the directory a session was last
 * seen in (from any event that does carry a location) so location-less events
 * can be routed to the right instance.
 */
const SESSION_LOCATION_TTL_MS = 30 * 60_000;
const SESSION_LOCATION_MAX = 2048;
const SESSION_LOCATIONS_KEY = Symbol.for('opencode-smart-voice-notify.session-locations');

interface SessionLocationRegistry {
  locations: Map<string, { directory: string; timestamp: number }>;
}

const getSessionLocationRegistry = (): SessionLocationRegistry => {
  const globalStore = globalThis as unknown as Record<symbol, SessionLocationRegistry | undefined>;
  let registry = globalStore[SESSION_LOCATIONS_KEY];
  if (!registry) {
    registry = { locations: new Map() };
    globalStore[SESSION_LOCATIONS_KEY] = registry;
  }
  return registry;
};

/** Remember the directory a session was seen in (process-wide). */
export const rememberSessionLocation = (sessionID: string, directory: string): void => {
  if (!sessionID || !directory) return;
  const registry = getSessionLocationRegistry();
  const now = Date.now();

  if (registry.locations.size >= SESSION_LOCATION_MAX) {
    for (const [id, entry] of registry.locations) {
      if (now - entry.timestamp > SESSION_LOCATION_TTL_MS) {
        registry.locations.delete(id);
      }
    }
  }

  registry.locations.set(sessionID, { directory, timestamp: now });
};

/** Look up the last directory a session was seen in, if still fresh. */
export const getSessionLocation = (sessionID: string | undefined): string | undefined => {
  if (!sessionID) return undefined;
  const entry = getSessionLocationRegistry().locations.get(sessionID);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_LOCATION_TTL_MS) {
    getSessionLocationRegistry().locations.delete(sessionID);
    return undefined;
  }
  return entry.directory;
};

// ============================================================
// Shell runner shim
// ============================================================

const isWindows = process.platform === 'win32';

/**
 * Quote a single interpolated value for a POSIX shell.
 *
 * This is only used on the `sh -c` fallback path.  When a command can be
 * spawned directly (the common case) the value travels as a real argv element
 * and needs no quoting at all.
 */
const quotePosixValue = (value: unknown): string => {
  const text = value === undefined || value === null ? '' : String(value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
};

/**
 * Quote a single interpolated value so it survives `cmd.exe` as one argument.
 *
 * `cmd.exe` has no backslash escapes, so the previous implementation's
 * `"${text.replace(/"/g, '\\"')}"` produced a literal `\"` in front of every
 * value — `where sleep` became `where \"sleep\"` and looked for a file whose
 * name literally contained quotes.  Caret-escaping cmd metacharacters and
 * doubling embedded quotes is the correct cmd quoting.
 */
const quoteCmdValue = (value: unknown): string => {
  const text = value === undefined || value === null ? '' : String(value);
  // Inside a double-quoted cmd token, only `%` and `!` still need escaping.
  const escaped = text.replace(/([%!])/g, '^$1').replace(/"/g, '""');
  return `"${escaped}"`;
};

const quoteValue = (value: unknown): string => (isWindows ? quoteCmdValue(value) : quotePosixValue(value));

/**
 * Build a shell command string from a tagged-template call.
 *
 * Only used on the shell fallback path.  On the direct-spawn path (the common
 * case) interpolated values travel as real argv elements and need no quoting.
 */
const buildCommand = (strings: TemplateStringsArray, values: Array<unknown>): string => {
  let command = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    command += quoteValue(values[i]);
    command += strings[i + 1] ?? '';
  }
  return command;
};

/**
 * `cmd.exe` builtins — these have no executable on disk, so a direct spawn of
 * the "binary" would fail with ENOENT and they must go through the shell.
 */
const WINDOWS_SHELL_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'echo', 'endlocal',
  'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path', 'pause', 'popd',
  'prompt', 'pushd', 'rd', 'ren', 'rename', 'rm', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time',
  'title', 'type', 'ver', 'verify', 'vol',
]);

/** Characters `cmd.exe` treats as syntax rather than as ordinary argument text. */
const CMD_METACHARACTERS = /[|<>&^()!,;\r\n]/;

interface ParsedCommand {
  /** Executable name taken from the static template text. */
  bin: string;
  /** Argument vector: static tokens plus interpolated values, in order. */
  args: string[];
  /** True when the command genuinely needs `cmd.exe` to interpret it. */
  needsShell: boolean;
}

/**
 * Tokenise the *static* template text into argv entries.
 *
 * Quoted runs are unwrapped and kept together, and characters inside them do
 * not count as shell syntax — otherwise `osascript -e "set volume to 100"`
 * would look like a redirection.
 */
const tokeniseStatic = (text: string): { tokens: string[]; needsShell: boolean } => {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quoteChar: '"' | "'" | undefined;
  let needsShell = false;

  const push = (): void => {
    if (hasCurrent) {
      tokens.push(current);
      current = '';
      hasCurrent = false;
    }
  };

  for (const char of text) {
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = undefined;
      } else {
        current += char;
      }
      hasCurrent = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      hasCurrent = true;
      continue;
    }

    if (/\s/.test(char)) {
      push();
      continue;
    }

    if (isWindows && CMD_METACHARACTERS.test(char)) {
      needsShell = true;
    }
    current += char;
    hasCurrent = true;
  }

  push();
  return { tokens, needsShell };
};

/**
 * Parse a tagged-template call into an executable plus an argument vector.
 *
 * Static template text supplies the program name and literal flags; every
 * interpolated value becomes exactly one argument, untouched.
 */
const parseCommand = (strings: TemplateStringsArray, values: Array<unknown>): ParsedCommand => {
  const tokens: string[] = [];
  let needsShell = false;

  const appendStatic = (text: string): void => {
    const parsed = tokeniseStatic(text);
    if (parsed.needsShell) needsShell = true;
    tokens.push(...parsed.tokens);
  };

  appendStatic(strings[0] ?? '');
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    tokens.push(value === undefined || value === null ? '' : String(value));
    appendStatic(strings[i + 1] ?? '');
  }

  const bin = tokens.shift() ?? '';
  if (bin && WINDOWS_SHELL_BUILTINS.has(bin.toLowerCase())) {
    needsShell = true;
  }

  return { bin, args: tokens, needsShell };
};

/** Kill a child and everything it spawned — `child.kill()` leaves grandchildren alive on Windows. */
const killProcessTree = (child: ReturnType<typeof spawn>): void => {
  if (!child.pid) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // Fall through to the plain kill below.
    }
  }
  try {
    child.kill();
  } catch {
    // Best effort.
  }
};

/**
 * Create a single shell execution: a thenable with `.quiet()/.nothrow()/.timeout()`.
 *
 * On Windows the command is spawned directly with an argv vector whenever the
 * static template text is free of `cmd.exe` syntax and the program is not a
 * shell builtin.  That matters: routing through `cmd.exe /d /s /c` corrupts
 * *every* quoted argument (including ones in the static text), which is what
 * made the PowerShell snippets fail to parse.  The direct path also removes
 * the 8191-character command-line limit and avoids a console window flash,
 * since the child is always spawned with `windowsHide`.
 *
 * Commands that really do need shell interpretation (pipes, redirection,
 * builtins like `exit`) fall back to the shell.
 *
 * Note that multi-line scripts (all PowerShell snippets in this plugin) must
 * NOT be passed through here — see `src/util/powershell.ts`.
 */
const createShellExecution = (parsed: ParsedCommand, shellCommand: string): ShellExecution => {
  let nothrow = false;
  let timedOut = false;
  let settled = false;
  let child: ReturnType<typeof spawn> | undefined;

  const useShell = !isWindows || parsed.needsShell;
  const bin = useShell ? (isWindows ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh') : parsed.bin;
  // `/s` is deliberately not used: it strips the outer quotes of the whole
  // command string, which mangles any quoted argument inside it.
  const args = useShell
    ? isWindows
      ? ['/d', '/c', shellCommand]
      : ['-c', shellCommand]
    : parsed.args;

  /** Resolves/rejects the promise below; kept outside so `.timeout()` can force it. */
  let forceFinish: ((result: ShellResult) => void) | undefined;

  const promise = new Promise<ShellResult>((resolve, reject) => {
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];

    const buildResult = (exitCode: number): ShellResult => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      return {
        stdout,
        stderr,
        exitCode,
        text: (enc?: BufferEncoding) => stdout.toString(enc),
        toString: () => stdout.toString(),
      };
    };

    const finish = (result: ShellResult, error?: Error): void => {
      if (settled) return;
      settled = true;
      // Reject on a spawn failure *or* a non-zero exit, unless `.nothrow()` was
      // requested — callers rely on this to detect failures without inspecting
      // the resolved result.
      if (!nothrow && (error || result.exitCode !== 0)) {
        const message =
          result.stderr.toString().trim() ||
          error?.message ||
          `Command failed with exit code ${result.exitCode}`;
        reject(Object.assign(new Error(message), result));
        return;
      }
      resolve(result);
    };

    forceFinish = (result: ShellResult) => finish(result);

    try {
      child = spawn(bin, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Never flash a console window for a background notification.
        windowsHide: true,
      });
    } catch (error) {
      finish(buildResult(127), error as Error);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

    child.on('error', (error) => {
      finish(buildResult(127), error);
    });

    child.on('close', (code: number | null) => {
      finish(buildResult(timedOut ? 124 : code ?? 1));
    });
  });

  const execution = promise as ShellExecution;
  execution.quiet = () => execution;
  execution.nothrow = () => {
    nothrow = true;
    return execution;
  };
  execution.timeout = (milliseconds: number) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) killProcessTree(child);
      // A killed shell can leave a grandchild holding the stdout pipe open, in
      // which case 'close' never fires and the caller waits forever.  Settle
      // regardless so a timeout always means "timed out".
      const bail = setTimeout(() => {
        forceFinish?.({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 124 });
      }, 2000);
      (bail as { unref?: () => void }).unref?.();
    }, milliseconds);
    // Do not keep the event loop alive purely for the timeout.
    (timer as { unref?: () => void }).unref?.();
    return execution;
  };

  return execution;
};

/** Synthesise a V1-compatible `$` shell runner for the V2 context. */
export const createShellRunner = (): ShellRunner => {
  const runner = ((strings: TemplateStringsArray, ...values: Array<unknown>): ShellExecution =>
    createShellExecution(parseCommand(strings, values), buildCommand(strings, values))) as ShellRunner;
  return runner;
};

// ============================================================
// Client shim
// ============================================================

/** Minimal V2 context surface used by the adapter. */
interface V2ContextLike {
  location: {
    directory: string;
    project: { id: string; directory: string; canonical: string };
  };
  session: { get: (input: { sessionID: string }) => Promise<unknown> };
}

/** Build a V1-compatible `client` shim backed by the V2 context. */
export const createClientShim = (ctx: V2ContextLike): OpenCodeClient => {
  const client: OpenCodeClient = {
    session: {
      get: async (input: unknown) => {
        const record = input as { sessionID?: string; path?: { id?: string } } | undefined;
        const sessionID = record?.sessionID ?? record?.path?.id;
        if (!sessionID) {
          throw new Error('session.get: sessionID is required');
        }
        return (await ctx.session.get({ sessionID })) as SessionGetResult;
      },
    },
    tui: {
      // OpenCode V2 does not expose a plugin-facing toast API.  Keep the method
      // present so the shared notification code takes its toast path without
      // throwing; the call is intentionally a no-op.
      showToast: async () => undefined,
    },
  };
  return client;
};

// ============================================================
// Event translation (V2 -> V1)
// ============================================================

/**
 * Translate a V2 event envelope into the V1 `{ type, properties }` shape the
 * existing handler understands.  Returns `null` for events we do not consume.
 */
export const translateV2Event = (event: V2EventEnvelope): PluginEvent | null => {
  const data = event.data ?? {};

  switch (event.type) {
    case 'session.idle':
      return { type: 'session.idle', properties: { sessionID: data.sessionID as string } };

    // V2 defines `session.idle` in its schema but never actually emits it: the
    // real "agent finished working" signal is `session.execution.succeeded`
    // (with `session.execution.failed` / `.interrupted` for the other outcomes).
    // Map it onto the V1 `session.idle` handler so completion notifications and
    // TTS reminders fire again.
    case 'session.execution.succeeded':
      return { type: 'session.idle', properties: { sessionID: data.sessionID as string } };

    case 'session.created':
      return {
        type: 'session.created',
        properties: {
          sessionID: data.sessionID as string,
          info: { id: data.sessionID as string },
        },
      };

    case 'session.execution.failed':
      return {
        type: 'session.error',
        properties: { sessionID: data.sessionID as string, error: data.error },
      };

    case 'permission.asked':
      // v2 permission shape — the handler flushes these immediately.
      return {
        type: 'permission.v2.asked',
        properties: {
          id: data.id as string,
          sessionID: data.sessionID as string,
          action: data.action as string,
          resources: data.resources as Array<string>,
          save: data.save as Array<string> | undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
          source: data.source as string | undefined,
        },
      };

    case 'permission.replied':
      return {
        type: 'permission.replied',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.requestID as string,
          reply: data.reply as string,
        },
      };

    case 'form.created': {
      const form = (data.form ?? {}) as { id?: string; sessionID?: string; fields?: Array<unknown> };
      return {
        type: 'question.v2.asked',
        properties: {
          id: form.id as string,
          sessionID: form.sessionID as string,
          questions: form.fields,
        },
      };
    }

    case 'form.replied':
      return {
        type: 'question.v2.replied',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.id as string,
          answers: data.answer as Array<Array<string>> | Array<unknown> | undefined,
        },
      };

    case 'form.cancelled':
      return {
        type: 'question.v2.rejected',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.id as string,
        },
      };

    case 'session.inbox.enqueued': {
      // User prompts are inbox items in V2.  Treat a user inbox item as the
      // equivalent of the V1 `message.updated` user-activity signal so pending
      // reminders are cancelled when the user responds.
      const item = (data.item ?? {}) as { type?: string };
      if (item.type !== 'user') {
        return null;
      }
      return {
        type: 'message.updated',
        properties: {
          sessionID: data.sessionID as string,
          info: {
            id: (data.inboxID as string) ?? `user-${Date.now()}`,
            role: 'user',
            // V1 compares message time (seconds) against idle time (ms).
            time: { created: Math.floor(Date.now() / 1000) },
          },
        },
      };
    }

    default:
      return null;
  }
};

// ============================================================
// V2 plugin definition
// ============================================================

/** V2 plugin instance created via `Plugin.define`. */
export const smartVoiceNotifyV2: Plugin.Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const shell = createShellRunner();
    const client = createClientShim(ctx as unknown as V2ContextLike);

    const directory = ctx.location.directory;
    const project = {
      id: ctx.location.project?.id,
      directory: ctx.location.project?.directory ?? directory,
      worktree: directory,
    };

    // Reuse the entire V1 notification engine by invoking it with shimmed
    // inputs.  The returned handlers expose `event` and `dispose`.
    const handlers = await SmartVoiceNotifyPlugin({
      project,
      client,
      $: shell,
      directory,
      worktree: directory,
    });

    const abort = new AbortController();
    let disposed = false;

    // Normalise the instance's own location once so event envelopes can be
    // matched regardless of trailing-slash / relative-path differences.
    const ownDirectory = resolvePath(directory);

    const eventTask = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          if (disposed) break;
          const envelope = raw as unknown as V2EventEnvelope;
          const data = envelope.data ?? {};
          const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined;

          // Remember which location each session belongs to.  Several V2 events
          // (notably `session.execution.succeeded`) carry no location, so this
          // lets the correct per-location instance handle them.
          const eventDirectory = envelope.location?.directory;
          if (sessionID && eventDirectory) {
            rememberSessionLocation(sessionID, eventDirectory);
          }

          // OpenCode V2 loads this plugin once per location while all instances
          // share one process-wide event stream.  Ignore events that belong to a
          // different location so each notification is handled by the instance
          // for the location it actually happened in (preserving per-project
          // names and sounds).  Events without a location fall back to the
          // remembered location for their session.
          const resolvedDirectory = eventDirectory ?? getSessionLocation(sessionID);
          if (resolvedDirectory && resolvePath(resolvedDirectory) !== ownDirectory) continue;

          // Safety net for events that carry no location (or for two instances
          // that share a directory): let only the first observer handle it so
          // audio is never played once per loaded location.
          const eventKey = envelope.id ?? (envelope.created !== undefined ? `${envelope.type}:${envelope.created}` : undefined);
          if (isDuplicateEvent(eventKey)) continue;
          const translated = translateV2Event(envelope);
          if (!translated) continue;
          try {
            await handlers.event?.({ event: translated });
          } catch {
            // The V1 handler already logs internally; never let one bad event
            // tear down the subscription.
          }
        }
      } catch {
        // Subscription ended (server shutdown / abort).  Nothing to do.
      }
    })();

    // V2 cleanup hook: stop consuming events and run the V1 dispose routine.
    return async () => {
      disposed = true;
      abort.abort();
      try {
        await eventTask;
      } catch {
        // ignore
      }
      try {
        await handlers.dispose?.();
      } catch {
        // ignore
      }
    };
  },
});
