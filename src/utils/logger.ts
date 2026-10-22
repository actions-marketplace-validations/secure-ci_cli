import { AsyncLocalStorage } from 'async_hooks';
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

  /** The labels of the job whose code is logging (see withJob). */
  private readonly job = new AsyncLocalStorage<string[]>();

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

  /**
   * Run `fn` with every message it logs (across awaits, and in anything
   * it starts) prefixed with `[label]`, so concurrent jobs' lines can be
   * told apart. Nested calls (a called workflow's jobs) join the labels;
   * with `replace`, `label` takes the place of the innermost one (a matrix
   * combination's label instead of its job's).
   */
  withJob<T>(label: string, fn: () => Promise<T>, replace = false): Promise<T> {
    const outer = this.job.getStore() ?? [];
    return this.job.run([...(replace ? outer.slice(0, -1) : outer), label], fn);
  }

  /**
   * `head` and the masked `message`, each non-empty line prefixed with the
   * job label inside withJob.
   */
  private format(head: string, message: string): string {
    const labels = this.job.getStore();
    const masked = head + this.mask(message);
    if (!labels) return masked;
    const prefix = `[${this.mask(labels.join(' / '))}] `;
    return masked
      .split('\n')
      .map((line) => (line ? prefix + line : line))
      .join('\n');
  }

  private maskArg(arg: unknown): unknown {
    return typeof arg === 'string' ? this.mask(arg) : arg;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      this.beforeWrite?.();
      console.log(
        colors.gray(this.format('[DEBUG] ', message)),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.beforeWrite?.();
      console.log(
        colors.blue(this.format('[INFO] ', message)),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  success(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.beforeWrite?.();
      console.log(
        colors.green(this.format('✓ ', message)),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      this.beforeWrite?.();
      console.warn(
        colors.yellow(this.format('[WARN] ', message)),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      this.beforeWrite?.();
      console.error(
        colors.red(this.format('[ERROR] ', message)),
        ...args.map((a) => this.maskArg(a))
      );
    }
  }

  step(message: string): void {
    this.beforeWrite?.();
    console.log(colors.cyan(`\n${this.format('→ ', message)}`));
  }

  result(message: string, success: boolean): void {
    const icon = success ? '✓' : '✗';
    const color = success ? colors.green : colors.red;
    this.beforeWrite?.();
    console.log(color(this.format(`${icon} `, message)));
  }
}

export const logger = new Logger();
