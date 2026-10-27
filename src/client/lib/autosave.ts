import type { DocumentDetail } from '../../shared/types.js';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'retrying' | 'error' | 'conflict';

export interface SaveError {
  status: number;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface AutosaveOptions {
  version: number;
  /** Content the server already has; updates that match it are ignored. */
  initialHtml?: string;
  save: (html: string, baseVersion: number) => Promise<{ version: number }>;
  onChange: (status: SaveStatus, info: { error?: SaveError; conflict?: DocumentDetail }) => void;
  /** Wait this long after the last keystroke before saving. */
  debounceMs?: number;
  /** First retry delay after a network/server error; doubles up to 30s. */
  retryMs?: number;
}

/**
 * Debounced, strictly sequential autosave with optimistic concurrency.
 *
 * - Rapid edits collapse into one request.
 * - Only one request is in flight; edits made meanwhile are sent next with
 *   the new version, so we never conflict with our own saves.
 * - A 409 stops autosave and hands the server's copy to the UI to resolve.
 * - Network/5xx errors retry with backoff and keep the latest content queued.
 *
 * Framework-agnostic so it can be unit tested without a browser.
 */
export class Autosave {
  private pending: string | null = null;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay: number;
  private status: SaveStatus = 'saved';
  private disposed = false;
  private lastSaved: string | undefined;
  version: number;

  constructor(private readonly opts: AutosaveOptions) {
    this.version = opts.version;
    this.lastSaved = opts.initialHtml;
    this.retryDelay = opts.retryMs ?? 2000;
  }

  get state() {
    return this.status;
  }

  get hasUnsavedChanges() {
    return this.pending !== null || this.inFlight;
  }

  /** Call on every edit with the full document HTML. */
  update(html: string) {
    if (html === this.lastSaved && !this.inFlight && this.status !== 'conflict') {
      // A no-op update (or edits undone back to the saved text): nothing to send.
      this.pending = null;
      clearTimeout(this.timer);
      if (this.status !== 'saved') this.setStatus('saved');
      return;
    }
    this.pending = html;
    if (this.status === 'conflict') return; // wait for the user to resolve it
    if (!this.inFlight && this.status !== 'retrying') this.setStatus('unsaved');
    this.schedule(this.opts.debounceMs ?? 800);
  }

  /** Save now (e.g. Ctrl+S, leaving the page). */
  flush() {
    clearTimeout(this.timer);
    void this.run();
  }

  /** The user chose the server's version: drop local changes and continue from it. */
  acceptRemote(version: number, html: string) {
    this.version = version;
    this.lastSaved = html;
    this.pending = null;
    this.setStatus('saved');
  }

  /** The user chose to keep their version: overwrite on top of the latest server version. */
  overwriteRemote(version: number, html: string) {
    this.version = version;
    this.pending = html;
    this.setStatus('unsaved');
    this.flush();
  }

  /** Someone else saved and we had nothing pending: adopt their version silently. */
  syncRemoteVersion(version: number, html: string) {
    if (!this.hasUnsavedChanges && this.status === 'saved') {
      this.version = version;
      this.lastSaved = html;
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private setStatus(status: SaveStatus, info: { error?: SaveError; conflict?: DocumentDetail } = {}) {
    // Skip no-op updates so typing doesn't re-render the UI on every keystroke.
    if (status === this.status && !info.error && !info.conflict) return;
    this.status = status;
    if (!this.disposed) this.opts.onChange(status, info);
  }

  private async run(): Promise<void> {
    if (this.inFlight || this.pending === null || this.status === 'conflict' || this.disposed) return;

    const html = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.setStatus('saving');

    try {
      const saved = await this.opts.save(html, this.version);
      this.version = saved.version;
      this.lastSaved = html;
      this.inFlight = false;
      this.retryDelay = this.opts.retryMs ?? 2000;
      if (this.pending !== null) {
        // More edits arrived while saving; send them straight away.
        return this.run();
      }
      this.setStatus('saved');
    } catch (raw) {
      this.inFlight = false;
      const error = raw as SaveError;
      // Keep the newest content: anything typed during the failed request wins.
      if (this.pending === null) this.pending = html;

      if (error.status === 409) {
        const conflict = (error.details as { current?: DocumentDetail } | undefined)?.current;
        this.setStatus('conflict', { error, conflict });
      } else if (error.retryable) {
        this.setStatus('retrying', { error });
        this.schedule(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      } else {
        this.setStatus('error', { error });
      }
    }
  }
}
