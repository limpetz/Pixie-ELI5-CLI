/**
 * A tiny terminal spinner with a live elapsed-seconds counter, shown while
 * Pixie is waiting on the model. Disabled automatically when stdout is not a
 * TTY (piped output stays clean), and always hands the cursor line back
 * cleanly before other output is written.
 */
export class Spinner {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private frame = 0;

  constructor(private readonly label = "thinking") {}

  private get isTTY(): boolean {
    return process.stdout.isTTY === true;
  }

  start(): void {
    if (!this.isTTY || this.timer) return;
    this.startedAt = Date.now();
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => this.render(), 100);
  }

  private render(): void {
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const f = this.frames[this.frame++ % this.frames.length];
    // Carriage return + clear line keeps the spinner on a single line.
    process.stdout.write(`\r\x1b[2K  \x1b[36m${f}\x1b[0m \x1b[2m${this.label}… ${secs}s\x1b[0m`);
  }

  /** Stops the spinner and clears its line. Safe to call when not running. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.isTTY) process.stdout.write("\r\x1b[2K");
    }
  }
}
