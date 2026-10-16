import fs from 'fs';
import notifier from 'node-notifier';
import os from 'os';
import path from 'path';

import type { DesktopNotifyOptions, NotificationResult } from '../types/notification.js';

/**
 * Desktop Notification Module for OpenCode Smart Voice Notify
 *
 * Provides cross-platform native desktop notifications using node-notifier.
 * Supports Windows Toast, macOS Notification Center, and Linux notify-send.
 *
 * Platform-specific behaviors:
 * - Windows: Uses SnoreToast for Windows 8+ toast notifications
 * - macOS: Uses terminal-notifier for Notification Center
 * - Linux: Uses notify-send (requires libnotify-bin package)
 *
 * @module util/desktop-notify
 * @see docs/ARCHITECT_PLAN.md - Phase 1, Task 1.2
 */

interface NotificationSupport {
  supported: boolean;
  reason?: string;
}

interface PlatformNotificationOptions {
  title: string;
  message: string;
  sound: boolean;
  wait: boolean;
  timeout?: number;
  subtitle?: string;
  urgency?: 'low' | 'normal' | 'critical';
  icon?: string;
  'app-name'?: string;
}

type NotifyArgs = Parameters<typeof notifier.notify>;
type NotifyCallback = Exclude<NotifyArgs[1], undefined>;

const getErrorMessage = (error: unknown): string => {
  const maybeError = error as { message?: unknown };
  return String(maybeError?.message);
};

/**
 * Debug logging to file.
 * Only logs when config.debugLog is enabled.
 * Writes to ~/.config/opencode/logs/smart-voice-notify-debug.log
 *
 * @param message - Message to log
 * @param enabled - Whether debug logging is enabled
 */
const debugLog = (message: string, enabled = false): void => {
  if (!enabled) return;

  try {
    const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
    const logsDir = path.join(configDir, 'logs');

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, 'smart-voice-notify-debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [desktop-notify] ${message}\n`);
  } catch {
    // Silently fail - logging should never break the plugin
  }
};

/**
 * Get the current platform identifier.
 */
export const getPlatform = (): NodeJS.Platform => os.platform();

/**
 * Check if desktop notifications are likely to work on this platform.
 *
 * @returns Support status and reason if not supported
 */
export const checkNotificationSupport = (): NotificationSupport => {
  const platform = getPlatform();

  switch (platform) {
    case 'darwin':
      // macOS always supports notifications via terminal-notifier (bundled)
      return { supported: true };

    case 'win32':
      // Windows 8+ supports toast notifications via SnoreToast (bundled)
      return { supported: true };

    case 'linux':
      // Linux requires notify-send from libnotify-bin package
      // We don't check for its existence here - node-notifier handles the fallback
      return { supported: true };

    default:
      return { supported: false, reason: `Unsupported platform: ${platform}` };
  }
};

/**
 * Build platform-specific notification options.
 * Normalizes options across different platforms while respecting their unique capabilities.
 *
 * @param title - Notification title
 * @param message - Notification body/message
 * @param options - Additional options
 * @returns Platform-normalized notification options
 */
const buildPlatformOptions = (
  title: string,
  message: string,
  options: DesktopNotifyOptions = {},
): PlatformNotificationOptions => {
  const platform = getPlatform();
  const { timeout = 5, sound = false, icon, subtitle, urgency } = options;

  // Base options common to all platforms
  const baseOptions: PlatformNotificationOptions = {
    title: title || 'OpenCode',
    message: message || '',
    sound,
    wait: false, // Don't block - fire and forget
  };

  // Add icon if provided and exists
  if (icon && fs.existsSync(icon)) {
    baseOptions.icon = icon;
  }

  // Platform-specific options
  switch (platform) {
    case 'darwin':
      // macOS Notification Center options
      return {
        ...baseOptions,
        timeout,
        subtitle: subtitle || undefined,
      };

    case 'win32':
      // Windows Toast options
      return {
        ...baseOptions,
        // Windows doesn't use timeout the same way - notifications persist until dismissed
        // sound can be true/false or a system sound name
        sound,
      };

    case 'linux':
      // Linux notify-send options
      return {
        ...baseOptions,
        timeout, // Timeout in seconds
        urgency: urgency || 'normal', // low, normal, critical
        'app-name': 'OpenCode Smart Notify',
      };

    default:
      return baseOptions;
  }
};

/**
 * Send a native desktop notification.
 *
 * This is the main function for sending cross-platform desktop notifications.
 * It handles platform-specific options and gracefully fails if notifications
 * are not supported or the notifier encounters an error.
 *
 * @param title - Notification title
 * @param message - Notification body/message
 * @param options - Notification options
 * @returns Result object
 *
 * @example
 * // Simple notification
 * await sendDesktopNotification('Task Complete', 'Your code is ready for review');
 *
 * @example
 * // With options
 * await sendDesktopNotification('Permission Required', 'Agent needs approval', {
 *   timeout: 10,
 *   urgency: 'critical',
 *   sound: true
 * });
 */
export const sendDesktopNotification = async (
  title: string,
  message: string,
  options: DesktopNotifyOptions = {},
): Promise<NotificationResult> => {
  // Handle null/undefined options gracefully
  const opts = options || {};
  const debug = opts.debugLog || false;

  try {
    // Check platform support
    const support = checkNotificationSupport();
    if (!support.supported) {
      debugLog(`Notification not supported: ${support.reason}`, debug);
      return { success: false, error: support.reason };
    }

    // Build platform-specific options
    const notifyOptions = buildPlatformOptions(title, message, opts);

    debugLog(`Sending notification: "${title}" - "${message}" (platform: ${getPlatform()})`, debug);

    // Send notification using promise wrapper.
    // Some environments never invoke the notifier callback; add a safety timeout.
    return await new Promise<NotificationResult>((resolve) => {
      let settled = false;

      const settle = (result: NotificationResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimeout);
        resolve(result);
      };

      // Some node-notifier backends invoke the callback seconds after the toast was
      // actually posted (Windows SnoreToast on a codec-less machine takes ~4s).
      // This is a short safety net so a never-firing callback cannot leak the
      // promise, not a measure of delivery — callers fire and forget, so keep the
      // budget small and word the log so it is not mistaken for a send failure.
      const callbackTimeoutMs = Math.min(1200, Math.max(200, (Number(opts.timeout ?? 5) || 5) * 1000 + 250));
      const safetyTimeout = setTimeout(() => {
        debugLog(`Notification callback still pending after ${callbackTimeoutMs}ms (toast already dispatched)`, debug);
        settle({ success: false, error: 'Notification callback timeout' });
      }, callbackTimeoutMs);

      const callback: NotifyCallback = (error, response) => {
        if (error) {
          debugLog(`Notification error: ${error.message}`, debug);
          settle({ success: false, error: error.message });
          return;
        }

        debugLog(`Notification sent successfully (response: ${response})`, debug);
        settle({ success: true });
      };

      try {
        notifier.notify(notifyOptions as NotifyArgs[0], callback);
      } catch (notifyError) {
        settle({ success: false, error: getErrorMessage(notifyError) });
      }
    });
  } catch (error) {
    const messageText = getErrorMessage(error);
    debugLog(`Notification exception: ${messageText}`, debug);
    return { success: false, error: messageText };
  }
};

/**
 * Send a notification for session idle (task completion).
 * Pre-configured for task completion notifications.
 *
 * @param message - Notification message
 * @param options - Additional options
 * @returns Result object
 */
export const notifyTaskComplete = async (
  message: string,
  options: DesktopNotifyOptions = {},
): Promise<NotificationResult> => {
  const title = options.projectName ? `✅ ${options.projectName} - Task Complete` : '✅ OpenCode - Task Complete';

  return sendDesktopNotification(title, message, {
    timeout: 5,
    sound: false, // We handle sound separately in the main plugin
    ...options,
  });
};

/**
 * Send a notification for permission requests.
 * Pre-configured for permission request notifications (more urgent).
 *
 * @param message - Notification message
 * @param options - Additional options
 * @returns Result object
 */
export const notifyPermissionRequest = async (
  message: string,
  options: DesktopNotifyOptions = {},
): Promise<NotificationResult> => {
  const count = options.count || 1;
  const title = options.projectName
    ? `⚠️ ${options.projectName} - Permission Required`
    : count > 1
      ? `⚠️ ${count} Permissions Required`
      : '⚠️ OpenCode - Permission Required';

  return sendDesktopNotification(title, message, {
    timeout: 10, // Longer timeout for permissions
    urgency: 'critical', // Higher urgency on Linux
    sound: false, // We handle sound separately
    ...options,
  });
};

/**
 * Send a notification for question requests (SDK v1.1.7+).
 * Pre-configured for question notifications.
 *
 * @param message - Notification message
 * @param options - Additional options
 * @returns Result object
 */
export const notifyQuestion = async (
  message: string,
  options: DesktopNotifyOptions = {},
): Promise<NotificationResult> => {
  const count = options.count || 1;
  const title = options.projectName
    ? `❓ ${options.projectName} - Question`
    : count > 1
      ? `❓ ${count} Questions Need Your Input`
      : '❓ OpenCode - Question';

  return sendDesktopNotification(title, message, {
    timeout: 8,
    urgency: 'normal',
    sound: false, // We handle sound separately
    ...options,
  });
};

/**
 * Send a notification for error events.
 * Pre-configured for error notifications (most urgent).
 *
 * @param message - Notification message
 * @param options - Additional options
 * @returns Result object
 */
export const notifyError = async (
  message: string,
  options: DesktopNotifyOptions = {},
): Promise<NotificationResult> => {
  const title = options.projectName ? `❌ ${options.projectName} - Error` : '❌ OpenCode - Error';

  return sendDesktopNotification(title, message, {
    timeout: 15, // Longer timeout for errors
    urgency: 'critical',
    sound: false, // We handle sound separately
    ...options,
  });
};

// Default export for convenience
export default {
  sendDesktopNotification,
  notifyTaskComplete,
  notifyPermissionRequest,
  notifyQuestion,
  notifyError,
  checkNotificationSupport,
  getPlatform,
};
