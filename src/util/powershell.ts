/**
 * Windows PowerShell execution helper.
 *
 * Every PowerShell snippet in this plugin is multi-line, contains quotes and
 * here-strings, and frequently contains characters that `cmd.exe` treats as
 * syntax (`&`, `|`, `<`, `>`, `^`, `%`).  Passing such a snippet through a
 * shell *command string* corrupts it — the classic symptom is
 *
 *     The string is missing the terminator: ".
 *        + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString
 *
 * because `cmd.exe` mangles the embedded quotes and newlines before
 * PowerShell ever sees them.  It also spawns a visible console window for every
 * notification, and it caps the command line at 8191 characters.
 *
 * This module therefore *never* uses a shell.  Scripts are handed to
 * `powershell.exe` as a single `-Command` argv element, with `windowsHide` set
 * so no console window flashes up.
 */

import { execFile } from 'node:child_process';

export interface PowerShellRunOptions {
  /** Hard wall-clock limit; the child is killed when it elapses. */
  timeoutMs?: number;
}

export interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type PowerShellRunner = (script: string, options?: PowerShellRunOptions) => Promise<PowerShellResult>;

const POWERSHELL_TIMEOUT_MS = 30_000;
const POWERSHELL_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Test seam.  `tests/setup.ts` installs a recording fake through
 * {@link setPowerShellRunner} so the suite can assert on PowerShell activity
 * without spawning real processes or playing real audio.
 */
let runnerOverride: PowerShellRunner | undefined;

export const setPowerShellRunner = (runner: PowerShellRunner | undefined): void => {
  runnerOverride = runner;
};

export const resetPowerShellRunner = (): void => {
  runnerOverride = undefined;
};

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  if (value === undefined || value === null) return '';
  return String(value);
};

const spawnPowerShell: PowerShellRunner = (script, options = {}) =>
  new Promise<PowerShellResult>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? POWERSHELL_TIMEOUT_MS,
        maxBuffer: POWERSHELL_MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const exitCode = error ? ((error as { code?: number | string }).code as number) || 1 : 0;
        resolve({
          stdout: toText(stdout),
          stderr: toText(stderr),
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
        });
      },
    );
  });

/**
 * Run a PowerShell script.  Resolves with the captured streams and exit code —
 * it never rejects, so callers decide how to react to a failure.
 */
export const runPowerShellScript: PowerShellRunner = (script, options = {}) => {
  if (runnerOverride) {
    return runnerOverride(script, options);
  }
  return spawnPowerShell(script, options);
};

/** Run a script and throw when it exits non-zero — for simple probes. */
export const runPowerShellScriptOrThrow = async (
  script: string,
  options: PowerShellRunOptions = {},
): Promise<PowerShellResult> => {
  const result = await runPowerShellScript(script, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`PowerShell failed: ${detail}`);
  }
  return result;
};