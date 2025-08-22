import { Readable, Writable, Duplex, Transform } from 'stream';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';

export const SampleFormat8Bit = 8;
export const SampleFormat16Bit = 16;
export const SampleFormat24Bit = 24;
export const SampleFormat32Bit = 32;
export const SampleFormatFloat32 = 1;

interface AudioOptions {
  sampleRate?: number;
  channelCount?: number;
  sampleFormat?: number;
  deviceId?: number;
  framesPerBuffer?: number;
  closeOnError?: boolean;
  highwaterMark?: number;
}

interface AudioIOOptions {
  inOptions?: AudioOptions;
  outOptions?: AudioOptions;
}

function getSampleFormatArgs(sampleFormat: number): { bitDepth: string; encoding: string } {
  switch (sampleFormat) {
    case SampleFormat8Bit:
      return { bitDepth: '8', encoding: 'unsigned-integer' };
    case SampleFormat16Bit:
      return { bitDepth: '16', encoding: 'signed-integer' };
    case SampleFormat24Bit:
      return { bitDepth: '24', encoding: 'signed-integer' };
    case SampleFormat32Bit:
      return { bitDepth: '32', encoding: 'signed-integer' };
    case SampleFormatFloat32:
      return { bitDepth: '32', encoding: 'floating-point' };
    default:
      return { bitDepth: '16', encoding: 'signed-integer' };
  }
}

class AudioInputStream extends Readable {
  private process: ChildProcess | null = null;
  private options: AudioOptions;
  private isStarted = false;
  private buffer: Buffer[] = [];
  private totalBytesRead = 0;
  private startTime: number = 0;

  constructor(options: AudioOptions) {
    super({ 
      highWaterMark: options.highwaterMark || 16384,
      objectMode: false 
    });
    this.options = {
      sampleRate: 44100,
      channelCount: 2,
      sampleFormat: SampleFormat16Bit,
      deviceId: -1,
      closeOnError: true,
      ...options
    };
  }

  start() {
    if (this.isStarted) return;
    this.isStarted = true;
    this.startTime = Date.now();
    this.startRecording();
  }

  private startRecording() {
    const { sampleRate, channelCount, sampleFormat } = this.options;
    const { bitDepth, encoding } = getSampleFormatArgs(sampleFormat!);
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        this.process = spawn('sox', [
          '-d',
          '-r', String(sampleRate),
          '-c', String(channelCount),
          '-b', bitDepth,
          '-e', encoding,
          '-t', 'raw',
          '-'
        ], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } else if (platform === 'linux') {
        const format = sampleFormat === SampleFormat16Bit ? 'S16_LE' : 
                       sampleFormat === SampleFormat32Bit ? 'S32_LE' : 'S16_LE';
        
        this.process = spawn('arecord', [
          '-f', format,
          '-r', String(sampleRate),
          '-c', String(channelCount),
          '-t', 'raw',
          '-q',
          '-'
        ], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } else if (platform === 'win32') {
        const format = sampleFormat === SampleFormat16Bit ? 's16le' :
                       sampleFormat === SampleFormat32Bit ? 's32le' : 
                       sampleFormat === SampleFormatFloat32 ? 'f32le' : 's16le';
        
        this.process = spawn('ffmpeg', [
          '-f', 'dshow',
          '-i', 'audio="Microphone (Realtek Audio)"',
          '-ar', String(sampleRate),
          '-ac', String(channelCount),
          '-f', format,
          '-'
        ], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
      }

      if (this.process && this.process.stdout) {
        this.process.stdout.on('data', (chunk: Buffer) => {
          const timestamp = (Date.now() - this.startTime) / 1000;
          (chunk as any).timestamp = timestamp;
          this.totalBytesRead += chunk.length;
          

          
          if (!this.push(chunk)) {
            this.process?.stdout?.pause();
          }
        });

        this.process.stderr?.on('data', (data) => {
          // Ignore stderr output
        });

        this.process.on('error', (err) => {
          if (this.options.closeOnError) {
            this.destroy(err);
          } else {
            this.emit('error', err);
          }
        });

        this.process.on('exit', (code, signal) => {
          if (code !== 0 && code !== null) {
            const err = new Error(`Audio input process exited with code ${code}`);
            if (this.options.closeOnError) {
              this.destroy(err);
            } else {
              this.emit('error', err);
            }
          }
          this.push(null);
        });
      }
    } catch (err) {
      if (this.options.closeOnError) {
        this.destroy(err as Error);
      } else {
        this.emit('error', err);
      }
    }
  }

  _read() {
    if (this.process?.stdout) {
      this.process.stdout.resume();
    }
    if (!this.isStarted) {
      this.start();
    }
  }

  _destroy(err: Error | null, callback: (err: Error | null) => void) {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    callback(err);
  }

  quit(callback?: () => void) {
    this.destroy();
    if (callback) callback();
  }

  abort(callback?: () => void) {
    this.destroy();
    if (callback) callback();
  }
}

class AudioOutputStream extends Writable {
  private process: ChildProcess | null = null;
  private options: AudioOptions;
  private isStarted = false;
  private totalBytesWritten = 0;

  constructor(options: AudioOptions) {
    super({ 
      highWaterMark: options.highwaterMark || 16384,
      objectMode: false,
      decodeStrings: false
    });
    this.options = {
      sampleRate: 44100,
      channelCount: 2,
      sampleFormat: SampleFormat16Bit,
      deviceId: -1,
      closeOnError: true,
      ...options
    };
  }

  start() {
    if (this.isStarted) return;
    this.isStarted = true;
    this.startPlayback();
  }

  private startPlayback() {
    const { sampleRate, channelCount, sampleFormat } = this.options;
    const { bitDepth, encoding } = getSampleFormatArgs(sampleFormat!);
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        this.process = spawn('sox', [
          '-r', String(sampleRate),
          '-c', String(channelCount),
          '-b', bitDepth,
          '-e', encoding,
          '-t', 'raw',
          '-',
          '-d'
        ], {
          stdio: ['pipe', 'ignore', 'ignore']
        });
      } else if (platform === 'linux') {
        const format = sampleFormat === SampleFormat16Bit ? 'S16_LE' : 
                       sampleFormat === SampleFormat32Bit ? 'S32_LE' : 'S16_LE';
        
        this.process = spawn('aplay', [
          '-f', format,
          '-r', String(sampleRate),
          '-c', String(channelCount),
          '-t', 'raw',
          '-q'
        ], {
          stdio: ['pipe', 'ignore', 'ignore']
        });
      } else if (platform === 'win32') {
        const format = sampleFormat === SampleFormat16Bit ? 's16le' :
                       sampleFormat === SampleFormat32Bit ? 's32le' : 
                       sampleFormat === SampleFormatFloat32 ? 'f32le' : 's16le';
        
        this.process = spawn('ffmpeg', [
          '-f', format,
          '-ar', String(sampleRate),
          '-ac', String(channelCount),
          '-i', '-',
          '-f', 'dsound',
          'default'
        ], {
          stdio: ['pipe', 'ignore', 'ignore']
        });
      }

      if (this.process) {
        this.process.on('error', (err) => {
          if (this.options.closeOnError) {
            this.destroy(err);
          } else {
            this.emit('error', err);
          }
        });

        this.process.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            const err = new Error(`Audio output process exited with code ${code}`);
            if (this.options.closeOnError) {
              this.destroy(err);
            } else {
              this.emit('error', err);
            }
          }
        });
      }
    } catch (err) {
      if (this.options.closeOnError) {
        this.destroy(err as Error);
      } else {
        this.emit('error', err);
      }
    }
  }

  _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
    if (!this.isStarted) {
      this.start();
    }

    if (this.process && this.process.stdin) {
      this.totalBytesWritten += chunk.length;
      this.process.stdin.write(chunk, callback);
    } else {
      callback(new Error('Audio output process not initialized'));
    }
  }

  _destroy(err: Error | null, callback: (err: Error | null) => void) {
    if (this.process) {
      if (this.process.stdin) {
        this.process.stdin.end();
      }
      this.process.kill('SIGTERM');
      this.process = null;
    }
    callback(err);
  }

  _final(callback: (error?: Error | null) => void) {
    if (this.process && this.process.stdin) {
      this.process.stdin.end();
    }
    callback();
  }

  quit(callback?: () => void) {
    this.end();
    if (callback) callback();
  }

  abort(callback?: () => void) {
    this.destroy();
    if (callback) callback();
  }
}

class AudioDuplexStream extends Duplex {
  private inputStream: AudioInputStream;
  private outputStream: AudioOutputStream;

  constructor(options: AudioIOOptions) {
    const inOpts = options.inOptions || {};
    const outOpts = options.outOptions || {};
    
    super({
      allowHalfOpen: false,
      readableHighWaterMark: inOpts.highwaterMark || 16384,
      writableHighWaterMark: outOpts.highwaterMark || 16384,
      objectMode: false,
      decodeStrings: false
    });

    this.inputStream = new AudioInputStream(inOpts);
    this.outputStream = new AudioOutputStream(outOpts);

    this.inputStream.on('data', (chunk) => {
      if (!this.push(chunk)) {
        this.inputStream.pause();
      }
    });

    this.inputStream.on('end', () => {
      this.push(null);
    });

    this.inputStream.on('error', (err) => {
      this.destroy(err);
    });

    this.outputStream.on('error', (err) => {
      this.destroy(err);
    });
  }

  start() {
    this.inputStream.start();
    this.outputStream.start();
  }

  _read() {
    this.inputStream.resume();
  }

  _write(chunk: any, encoding: string, callback: (error?: Error | null) => void) {
    this.outputStream.write(chunk, encoding as BufferEncoding, callback);
  }

  _destroy(err: Error | null, callback: (err: Error | null) => void) {
    this.inputStream.destroy();
    this.outputStream.destroy();
    callback(err);
  }

  quit(callback?: () => void) {
    this.inputStream.quit();
    this.outputStream.quit();
    if (callback) callback();
  }

  abort(callback?: () => void) {
    this.inputStream.abort();
    this.outputStream.abort();
    if (callback) callback();
  }
}

export class AudioIO extends EventEmitter {
  private stream: Readable | Writable | Duplex;
  private options: AudioIOOptions;

  constructor(options: AudioIOOptions) {
    super();
    this.options = options;

    if (options.inOptions && options.outOptions) {
      this.stream = new AudioDuplexStream(options);
    } else if (options.inOptions) {
      this.stream = new AudioInputStream(options.inOptions);
    } else if (options.outOptions) {
      this.stream = new AudioOutputStream(options.outOptions);
    } else {
      throw new Error('AudioIO requires either inOptions or outOptions');
    }

    this.stream.on('error', (err) => {
      this.emit('error', err);
    });

    this.stream.on('close', () => {
      this.emit('close');
      this.emit('closed');
    });

    this.stream.on('finish', () => {
      this.quit();
      this.emit('finish');
      this.emit('finished');
    });
  }

  start() {
    if ('start' in this.stream) {
      (this.stream as any).start();
    }
    return this.stream;
  }

  quit(callback?: () => void) {
    if ('quit' in this.stream) {
      (this.stream as any).quit(callback);
    } else {
      this.stream.destroy();
      if (callback) callback();
    }
  }

  abort(callback?: () => void) {
    if ('abort' in this.stream) {
      (this.stream as any).abort(callback);
    } else {
      this.stream.destroy();
      if (callback) callback();
    }
  }

  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    return this.stream.pipe(destination, options);
  }

  unpipe(destination?: NodeJS.WritableStream): this {
    (this.stream as Readable).unpipe(destination);
    return this;
  }

  write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    if (this.stream instanceof Writable || this.stream instanceof Duplex) {
      if (typeof encoding === 'function') {
        return this.stream.write(chunk, encoding);
      } else if (encoding) {
        return this.stream.write(chunk, encoding, callback);
      } else {
        return this.stream.write(chunk, callback);
      }
    }
    return false;
  }

  end(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void): void {
    if (this.stream instanceof Writable || this.stream instanceof Duplex) {
      if (typeof encoding === 'function') {
        this.stream.end(chunk, encoding);
      } else if (encoding) {
        this.stream.end(chunk, encoding, callback);
      } else if (chunk) {
        this.stream.end(chunk, callback);
      } else {
        this.stream.end();
      }
    }
  }

  on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === 'data' && (this.stream instanceof Readable || this.stream instanceof Duplex)) {
      this.stream.on('data', listener);
    } else {
      super.on(event, listener);
    }
    return this;
  }

  once(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === 'data' && (this.stream instanceof Readable || this.stream instanceof Duplex)) {
      this.stream.once('data', listener);
    } else {
      super.once(event, listener);
    }
    return this;
  }
}

export function getDevices(): Array<any> {
  const platform = os.platform();
  const devices = [];

  if (platform === 'darwin') {
    try {
      const result = spawn('system_profiler', ['SPAudioDataType']);
      devices.push({
        id: 0,
        name: 'Built-in Microphone',
        maxInputChannels: 2,
        maxOutputChannels: 0,
        defaultSampleRate: 44100,
        defaultLowInputLatency: 0.002,
        defaultLowOutputLatency: 0.01,
        defaultHighInputLatency: 0.012,
        defaultHighOutputLatency: 0.1,
        hostAPIName: 'Core Audio'
      });
      devices.push({
        id: 1,
        name: 'Built-in Output',
        maxInputChannels: 0,
        maxOutputChannels: 2,
        defaultSampleRate: 44100,
        defaultLowInputLatency: 0.01,
        defaultLowOutputLatency: 0.002,
        defaultHighInputLatency: 0.1,
        defaultHighOutputLatency: 0.012,
        hostAPIName: 'Core Audio'
      });
    } catch (e) {
      // Fall through to defaults
    }
  }

  if (devices.length === 0) {
    devices.push({
      id: -1,
      name: 'Default Input Device',
      maxInputChannels: 2,
      maxOutputChannels: 0,
      defaultSampleRate: 44100,
      defaultLowInputLatency: 0.01,
      defaultLowOutputLatency: 0.01,
      defaultHighInputLatency: 0.1,
      defaultHighOutputLatency: 0.1,
      hostAPIName: 'Default'
    });
    devices.push({
      id: -1,
      name: 'Default Output Device',
      maxInputChannels: 0,
      maxOutputChannels: 2,
      defaultSampleRate: 44100,
      defaultLowInputLatency: 0.01,
      defaultLowOutputLatency: 0.01,
      defaultHighInputLatency: 0.1,
      defaultHighOutputLatency: 0.1,
      hostAPIName: 'Default'
    });
  }

  return devices;
}

export function getHostAPIs(): any {
  const platform = os.platform();
  let hostAPIName = 'Default';

  if (platform === 'darwin') {
    hostAPIName = 'Core Audio';
  } else if (platform === 'win32') {
    hostAPIName = 'MME';
  } else if (platform === 'linux') {
    hostAPIName = 'ALSA';
  }

  return {
    defaultHostAPI: 0,
    HostAPIs: [
      {
        id: 0,
        name: hostAPIName,
        type: hostAPIName,
        deviceCount: 2,
        defaultInput: 0,
        defaultOutput: 1
      }
    ]
  };
}