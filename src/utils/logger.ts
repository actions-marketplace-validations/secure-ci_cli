import { colors } from './ansi';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private secrets: Set<string> = new Set();

  private beforeWrite?: () => void;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Run `hook` before each message is written (e.g. to clear an in-place
   * progress line); undefined removes it.
   */
  setBeforeWrite(hook: (() => void) | undefined): void {
    this.beforeWrite = hook;
  }

  /**
   * Register secret values so they get masked (replaced with `***`) in any
   * subsequent log output, mirroring GitHub Actions' own secret masking.
   * Short/empty values are ignored to avoid masking incidental characters.
   */
  registerSecrets(values: Record<string, string> | undefined): void {
    if (!values) return;
    for (const value of Object.values(values)) {
      if (value && value.length >= 3) {
        this.secrets.add(value);
      }
    }
  }

  clearSecrets(): void {
    this.secrets.clear();
  }

  private mask(text: string): string {
    if (this.secrets.size === 0) return text;
    let masked = text;
    for (const secret of this.secrets) {
      masked = masked.split(secret).join('***');
    }
    return masked;
  }

  private maskArg(arg: unknown): unknown {
    return typeof arg === 'string' ? this.mask(arg) : arg;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      this.beforeWrite?.();
      console.log(
        colors.gray(`[DEBUG] ${this.mask(message)}`),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.beforeWrite?.();
      console.log(
        colors.blue(`[INFO] ${this.mask(message)}`),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  success(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.beforeWrite?.();
      console.log(
        colors.green(`✓ ${this.mask(message)}`),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      this.beforeWrite?.();
      console.warn(
        colors.yellow(`[WARN] ${this.mask(message)}`),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      this.beforeWrite?.();
      console.error(
        colors.red(`[ERROR] ${this.mask(message)}`),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  step(message: string): void {
    this.beforeWrite?.();
    console.log(colors.cyan(`\n→ ${this.mask(message)}`));
  }

  result(message: string, success: boolean): void {
    const icon = success ? '✓' : '✗';
    const color = success ? colors.green : colors.red;
    this.beforeWrite?.();
    console.log(color(`${icon} ${this.mask(message)}`));
  }
}

export const logger = new Logger();
