// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Mock proxies to control from tests
const mockExecFile = mock((file, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  queueMicrotask(() => done?.(null, '', ''));
  return { kill: mock(() => {}) };
});

const mockElevenLabsConvert = mock(() => Promise.resolve({
  [Symbol.asyncIterator]: async function* () {
    yield Buffer.from('audio');
  }
}));

const mockEdgeTTSSetMetadata = mock(() => Promise.resolve());
const mockEdgeTTSToFile = mock(() => Promise.resolve({ audioFilePath: 'edge-tts.mp3' }));

// Mock the dependencies before importing tts.js
mock.module('node:child_process', () => ({
  execFile: mockExecFile,
}));

mock.module('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: class {
    constructor() {
      this.textToSpeech = {
        convert: mockElevenLabsConvert
      };
    }
  }
}));

mock.module('msedge-tts', () => ({
  MsEdgeTTS: class {
    constructor() {
      this.setMetadata = mockEdgeTTSSetMetadata;
      this.toFile = mockEdgeTTSToFile;
    }
  },
  OUTPUT_FORMAT: {
    AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3'
  }
}));

import { getTTSConfig, createTTS } from '../../src/util/tts.js';
import { 
  createTestTempDir, 
  cleanupTestTempDir,
  getTestTempDir,
  createTestConfig,
  createMinimalConfig,
  createMockShellRunner,
  createMockClient,
  testFileExists,
  getPowerShellCalls,
  scriptRunner
} from '../setup.js';

/** The recorded PowerShell scripts, newest last. */
const psScripts = () => getPowerShellCalls().map((call) => call.command);
const lastPsScript = () => psScripts().at(-1) ?? '';

describe('tts.js', () => {
  describe('getTTSConfig()', () => {
    beforeEach(() => {
      createTestTempDir();
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should return default configuration when no config file exists', () => {
      const config = getTTSConfig();
      expect(config).toBeDefined();
      expect(config.ttsEngine).toBe('elevenlabs');
      expect(config.enableTTS).toBe(true);
      expect(config.notificationMode).toBe('sound-first');
    });

    it('should respect user overrides from config file', () => {
      const userConfig = {
        ttsEngine: 'openai',
        enableTTS: false,
        openaiTtsEndpoint: 'http://localhost:8880'
      };
      createTestConfig(userConfig);

      const config = getTTSConfig();
      expect(config.ttsEngine).toBe('openai');
      expect(config.enableTTS).toBe(false);
      expect(config.openaiTtsEndpoint).toBe('http://localhost:8880');
    });

    it('should include all required tts message arrays', () => {
      const config = getTTSConfig();
      expect(Array.isArray(config.idleTTSMessages)).toBe(true);
      expect(Array.isArray(config.permissionTTSMessages)).toBe(true);
      expect(Array.isArray(config.questionTTSMessages)).toBe(true);
      expect(Array.isArray(config.idleReminderTTSMessages)).toBe(true);
      expect(Array.isArray(config.permissionReminderTTSMessages)).toBe(true);
      expect(Array.isArray(config.questionReminderTTSMessages)).toBe(true);
    });
  });

  describe('createTTS()', () => {
    let mockShell;
    let mockClient;

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      mockClient = createMockClient();
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should initialize with config', () => {
      const tts = createTTS({ $: mockShell, client: mockClient });
      expect(tts.config).toBeDefined();
      expect(tts.config.ttsEngine).toBe('elevenlabs');
    });

    it('should create logs directory if debugLog is enabled', () => {
      createTestConfig({ debugLog: true });
      createTTS({ $: mockShell, client: mockClient });
      
      expect(testFileExists('logs')).toBe(true);
    });

    it('should have required methods', () => {
      const tts = createTTS({ $: mockShell, client: mockClient });
      expect(typeof tts.speak).toBe('function');
      expect(typeof tts.announce).toBe('function');
      expect(typeof tts.wakeMonitor).toBe('function');
      expect(typeof tts.forceVolume).toBe('function');
      expect(typeof tts.playAudioFile).toBe('function');
    });
  });

  describe('playAudioFile()', () => {
    let mockShell;
    let tts;
    let platformSpy;

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
    });

    afterEach(() => {
      platformSpy?.mockRestore();
      cleanupTestTempDir();
    });

    const createTTSForPlatform = (platform) => {
      platformSpy?.mockRestore();
      platformSpy = spyOn(os, 'platform').mockReturnValue(platform);
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
      return tts;
    };

    it('should play via the .NET MediaPlayer backend on win32', async () => {
      // .NET is the first Windows backend; the rest are fallbacks.
      if (process.platform === 'win32') {
        await tts.playAudioFile('test.mp3');
        expect(psScripts()).toHaveLength(1);
        expect(lastPsScript()).toContain('powershell.exe');
        expect(lastPsScript()).toContain('System.Windows.Media.MediaPlayer');
        expect(lastPsScript()).toContain('test.mp3');
        expect(lastPsScript()).not.toContain('mciSendString');
      }
    });

    it('should fall back through the backend chain when the first backend fails', async () => {
      if (process.platform === 'win32') {
        scriptRunner({ exitCode: 1, stderr: 'simulated .NET failure' });

        await tts.playAudioFile('test.mp3');

        const scripts = psScripts();
        expect(scripts.length).toBeGreaterThanOrEqual(2);
        expect(scripts[0]).toContain('System.Windows.Media.MediaPlayer');
        expect(scripts[1]).toContain('mciSendString');
        // The final fallback hands off to the user's default media player.
        expect(scripts.at(-1)).toContain('Start-Process');
        scriptRunner({ exitCode: 0, stderr: '' });
      }
    });

    it('should remember failing backends instead of retrying them every time', async () => {
      if (process.platform === 'win32') {
        scriptRunner({ exitCode: 1, stderr: 'everything is broken' });

        await tts.playAudioFile('test.mp3');
        const firstPass = psScripts().length;

        await tts.playAudioFile('test.mp3');
        // A backend that keeps failing must not be probed again on every
        // notification — each retry of WPF MediaPlayer costs seconds.
        expect(psScripts().length).toBeLessThan(firstPass * 2);

        scriptRunner({ exitCode: 0, stderr: '' });
      }
    });

    it('should respect loops parameter on win32', async () => {
      if (process.platform === 'win32') {
        await tts.playAudioFile('test.mp3', 3);
        expect(psScripts()).toHaveLength(1); // One powershell call with a loop inside
        expect(lastPsScript()).toContain('-lt 3');
      }
    });

    it('should run PowerShell directly even when the shell runner is unavailable', async () => {
      if (process.platform === 'win32') {
        // PowerShell scripts must never be interpolated into a shell command
        // string: a shell round-trip mangles the embedded quotes and here-strings.
        tts = createTTS({ client: createMockClient() });
        const unusedShell = createMockShellRunner();

        await tts.playAudioFile('C:\\temp\\notify.mp3');

        expect(psScripts()).toHaveLength(1);
        expect(lastPsScript()).toContain('System.Windows.Media.MediaPlayer');
        expect(lastPsScript()).toContain('notify.mp3');
        void unusedShell;
      }
    });

    it('should dispatch to Windows playback when os.platform() reports win32', async () => {
      tts = createTTSForPlatform('win32');

      await tts.playAudioFile('notify.mp3', 2);

      expect(psScripts()).toHaveLength(1);
      expect(lastPsScript()).toContain('powershell.exe');
      expect(lastPsScript()).toContain('System.Windows.Media.MediaPlayer');
      expect(lastPsScript()).toContain('-lt 2');
    });

    it('should not use PowerShell playback backticks that break command parsing', async () => {
      if (process.platform === 'win32') {
        // The old MCI script embedded `"open \`"$filePath\`" alias $alias"`, which
        // is what produced `The string is missing the terminator: ".`
        tts = createTTSForPlatform('win32');
        scriptRunner({ exitCode: 1 });
        await tts.playAudioFile('notify.mp3');
        const mci = psScripts().find((s) => s.includes('mciSendString')) ?? '';
        expect(mci).toContain(`'open "' + $filePath + '" alias ' + $alias`);
        expect(mci).not.toContain('`"');
        scriptRunner({ exitCode: 0 });
      }
    });

    it('should honour a restricted windowsAudioBackends configuration', async () => {
      if (process.platform === 'win32') {
        createTestConfig({ windowsAudioBackends: ['shell'] });
        tts = createTTS({ $: mockShell, client: createMockClient() });

        await tts.playAudioFile('notify.mp3');

        expect(psScripts()).toHaveLength(1);
        expect(lastPsScript()).toContain('Start-Process');
      }
    });

    it('should dispatch to afplay when os.platform() reports darwin', async () => {
      tts = createTTSForPlatform('darwin');

      await tts.playAudioFile('/tmp/notify.mp3', 2);

      expect(mockShell.getCallCount()).toBe(2);
      expect(mockShell.getCalls().every((call) => call.command.includes('afplay /tmp/notify.mp3'))).toBe(true);
    });

    it('should dispatch to Linux audio playback when os.platform() reports linux', async () => {
      tts = createTTSForPlatform('linux');

      await tts.playAudioFile('/tmp/notify.mp3', 2);

      expect(mockShell.getCallCount()).toBe(2);
      expect(mockShell.getCalls().every((call) => call.command.includes('paplay /tmp/notify.mp3'))).toBe(true);
    });
  });

  describe('speakWithOpenAI()', () => {
    let mockShell;
    let mockClient;
    let tts;
    let originalFetch;

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      mockClient = createMockClient();
      originalFetch = global.fetch;
    });

    afterEach(() => {
      cleanupTestTempDir();
      global.fetch = originalFetch;
    });

    it('should return false if no endpoint is configured', async () => {
      createTestConfig({ openaiTtsEndpoint: '' });

      // Mock edge and SAPI to fail so we don't get true from a fallback.
      mockEdgeTTSToFile.mockImplementation(() => Promise.reject(new Error('Edge failed')));
      scriptRunner({ exitCode: 1, stderr: 'SAPI failed' });
      tts = createTTS({ $: mockShell, client: mockClient });

      const success = await tts.speak('Hello', { ttsEngine: 'openai' });
      expect(success).toBe(false);
      scriptRunner({ exitCode: 0, stderr: '' });
    });

    it('should make a POST request to the correct endpoint', async () => {
      createTestConfig({ 
        openaiTtsEndpoint: 'http://localhost:8880',
        ttsEngine: 'openai',
        enableTTS: true,
        enableSound: true
      });
      tts = createTTS({ $: mockShell, client: mockClient });

      global.fetch = mock(() => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
      }));

      await tts.speak('Hello');

      expect(global.fetch).toHaveBeenCalled();
      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe('http://localhost:8880/v1/audio/speech');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body).input).toBe('Hello');
    });

    it('should include Authorization header if API key is provided', async () => {
      createTestConfig({ 
        openaiTtsEndpoint: 'http://localhost:8880',
        openaiTtsApiKey: 'sk-123',
        ttsEngine: 'openai',
        enableTTS: true,
        enableSound: true
      });
      tts = createTTS({ $: mockShell, client: mockClient });

      global.fetch = mock(() => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
      }));

      await tts.speak('Hello');

      const options = global.fetch.mock.calls[0][1];
      expect(options.headers['Authorization']).toBe('Bearer sk-123');
    });

    it('should return false if fetch fails', async () => {
      createTestConfig({ 
        openaiTtsEndpoint: 'http://localhost:8880',
        ttsEngine: 'openai',
        enableTTS: true,
        enableSound: true
      });
      tts = createTTS({ $: mockShell, client: mockClient });

      global.fetch = mock(() => Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Error')
      }));
      
      // Mock edge and SAPI to fail so we don't get true from a fallback.
      mockEdgeTTSToFile.mockImplementation(() => Promise.reject(new Error('Edge failed')));
      // On win32, SAPI is tried next; it fails when the PowerShell script does.
      scriptRunner({ exitCode: 1, stderr: 'SAPI failed' });
      tts = createTTS({ $: mockShell, client: mockClient });

      const success = await tts.speak('Hello');
      expect(success).toBe(false);
      scriptRunner({ exitCode: 0, stderr: '' });
    });
  });

  describe('speakWithElevenLabs()', () => {
    let mockShell;
    let mockClient;
    let tts;

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      mockClient = createMockClient();
      mockElevenLabsConvert.mockClear();
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should call ElevenLabs API when configured', async () => {
      createTestConfig({ 
        elevenLabsApiKey: 'valid-key',
        ttsEngine: 'elevenlabs',
        enableTTS: true,
        enableSound: true
      });
      tts = createTTS({ $: mockShell, client: mockClient });
      
      await tts.speak('Hello');
      expect(mockElevenLabsConvert).toHaveBeenCalled();
    });
  });

  describe('ElevenLabs Quota Handling', () => {
    let mockShell;
    let mockClient;
    let tts;

    beforeEach(async () => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      mockClient = createMockClient();
      mockElevenLabsConvert.mockClear();
      mockEdgeTTSToFile.mockClear();
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should fall back to Edge TTS when ElevenLabs returns 401 (quota exceeded)', async () => {
      createTestConfig({ 
        elevenLabsApiKey: 'valid-key',
        ttsEngine: 'elevenlabs',
        enableTTS: true,
        enableSound: true
      });
      tts = createTTS({ $: mockShell, client: mockClient });

      // Make the convert method fail with 401
      mockElevenLabsConvert.mockImplementation(() => {
        const err = new Error('Quota exceeded');
        err.statusCode = 401;
        return Promise.reject(err);
      });

      // It should try ElevenLabs, fail, show toast, then try Edge TTS
      await tts.speak('Hello');

      expect(mockClient.tui.getToastCalls().some(c => c.message.includes('ElevenLabs quota exceeded'))).toBe(true);
      expect(mockEdgeTTSToFile).toHaveBeenCalled();

      // Subsequent calls should skip ElevenLabs immediately
      mockElevenLabsConvert.mockClear();
      await tts.speak('Hello again');
      expect(mockElevenLabsConvert).not.toHaveBeenCalled();
    });
  });

  describe('wakeMonitor()', () => {
    let mockShell;
    let tts;

    const sentWakeKeys = () => psScripts().filter((s) => s.includes('SendWait'));

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
      // Idle seconds are read back from the idle-probe script's stdout.
      scriptRunner({ exitCode: 0, stdout: '60' });
    });

    afterEach(() => {
      cleanupTestTempDir();
      scriptRunner({ stdout: '' });
    });

    it('should skip wake if idle time is below threshold', async () => {
      if (process.platform === 'win32') {
        scriptRunner({ stdout: '10' });

        await tts.wakeMonitor();
        expect(sentWakeKeys()).toHaveLength(0);
      }
    });

    it('should wake if idle time is above threshold', async () => {
      if (process.platform === 'win32') {
        scriptRunner({ stdout: '60' });

        await tts.wakeMonitor();
        expect(sentWakeKeys()).toHaveLength(1);
        expect(sentWakeKeys()[0]).toContain('SendWait');
      }
    });

    it('should force wake if force parameter is true', async () => {
      if (process.platform === 'win32') {
        scriptRunner({ stdout: '10' });

        await tts.wakeMonitor(true);
        expect(sentWakeKeys()).toHaveLength(1);
      }
    });
  });

  describe('forceVolume()', () => {
    let mockShell;
    let tts;

    beforeEach(() => {
      createTestTempDir();
      // Create config with forceVolume enabled (default is now false)
      createTestConfig(createMinimalConfig({ forceVolume: true, volumeThreshold: 50 }));
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should skip if volume is above threshold', async () => {
      if (process.platform === 'win32') {
        createTestConfig(createMinimalConfig({ forceVolume: true, volumeThreshold: 50 }));
        scriptRunner({ stdout: '80' });
        tts = createTTS({ $: mockShell, client: createMockClient() });

        await tts.forceVolume();
        expect(psScripts().some((s) => s.includes('SendKeys([char]175)'))).toBe(false);
        scriptRunner({ stdout: '' });
      }
    });

    it('should force volume if below threshold', async () => {
      if (process.platform === 'win32') {
        createTestConfig(createMinimalConfig({ forceVolume: true, volumeThreshold: 50 }));
        scriptRunner({ stdout: '20' });
        tts = createTTS({ $: mockShell, client: createMockClient() });

        await tts.forceVolume();
        expect(psScripts().some((s) => s.includes('SendKeys([char]175)'))).toBe(true);
        scriptRunner({ stdout: '' });
      }
    });
  });

  describe('speakWithSAPI()', () => {
    let mockShell;
    let tts;

    beforeEach(() => {
      createTestTempDir();
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should generate and execute PowerShell script on win32', async () => {
      if (process.platform === 'win32') {
        await tts.speak('Hello', { ttsEngine: 'sapi' });

        // The script is handed straight to powershell.exe as a single -Command
        // argument; it used to be written to a .ps1 and passed through the `$`
        // shell runner, where the path quoting was mangled.
        expect(psScripts().some((s) => s.includes('System.Speech') && s.includes('SpeakSsml'))).toBe(true);
      }
    });
  });

  describe('announce()', () => {
    let mockShell;
    let tts;

    beforeEach(() => {
      createTestTempDir();
      // Create config with forceVolume enabled (default is now false)
      createTestConfig(createMinimalConfig({ forceVolume: true, volumeThreshold: 50, wakeMonitor: true }));
      mockShell = createMockShellRunner();
      tts = createTTS({ $: mockShell, client: createMockClient() });
    });

    afterEach(() => {
      cleanupTestTempDir();
    });

    it('should call wakeMonitor and forceVolume before speaking', async () => {
      if (process.platform === 'win32') {
        // Create config with forceVolume and wakeMonitor enabled
        createTestConfig(createMinimalConfig({ forceVolume: true, volumeThreshold: 50, wakeMonitor: true, idleThresholdSeconds: 60 }));
        // The idle probe and the volume probe share one PowerShell runner and
        // need different answers: idle 60s (>= threshold) and volume 20 (< 50).
        scriptRunner({
          respond: [
            { match: 'IdleCheck', stdout: '60' },
            { match: 'Win32VolCheck', stdout: '20' },
          ],
        });
        tts = createTTS({ $: mockShell, client: createMockClient() });

        await tts.announce('Hello');

        expect(psScripts().some((s) => s.includes('SendWait'))).toBe(true);
        expect(psScripts().some((s) => s.includes('SendKeys([char]175)'))).toBe(true);
        scriptRunner({ stdout: '', respond: [] });
      }
    });
  });
});
