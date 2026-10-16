import { logger } from './logger';

/** Where progress is written: stderr, so stdout (e.g. JSON) stays clean. */
export interface ProgressStream {
  isTTY?: boolean;
  write(text: string): boolean;
}

const CLEAR_LINE = '\r\x1b[K';

/**
 * Progress for a slow phase, e.g. resolving actions over the network. On a
 * terminal it updates one line in place (`Label [3/10] item`); elsewhere
 * (CI logs) it prints a line per item. The total can grow as work is found.
 */
export class Progress {
  private count = 0;
  private drawn = false;
  private readonly tty: boolean;

  constructor(
    private readonly label: string,
    private total: number,
    private readonly out: ProgressStream = process.stderr
  ) {
    this.tty = !!out.isTTY;
    // A log line would otherwise be appended to the half-drawn line.
    if (this.tty) logger.setBeforeWrite(() => this.clear());
  }

  /** More items were found to process. */
  grow(n = 1): void {
    this.total += n;
  }

  tick(item: string): void {
    this.count++;
    if (this.count > this.total) this.total = this.count;
    const line = `${this.label} [${this.count}/${this.total}] ${item}`;
    if (this.tty) {
      this.out.write(CLEAR_LINE + line);
      this.drawn = true;
    } else {
      this.out.write(line + '\n');
    }
  }

  /** End the phase, leaving `summary` (if any work was done). */
  done(summary?: string): void {
    if (this.tty) logger.setBeforeWrite(undefined);
    if (this.count === 0) return;
    this.clear();
    if (summary) this.out.write(summary + '\n');
  }

  private clear(): void {
    if (this.drawn) {
      this.out.write(CLEAR_LINE);
      this.drawn = false;
    }
  }
}
