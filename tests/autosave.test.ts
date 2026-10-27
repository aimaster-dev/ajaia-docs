import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosave, type SaveError, type SaveStatus } from '../src/client/lib/autosave.js';

const DEBOUNCE = 500;

function setup(save: (html: string, base: number) => Promise<{ version: number }>) {
  const statuses: SaveStatus[] = [];
  const conflicts: unknown[] = [];
  const saver = new Autosave({
    version: 1,
    save,
    debounceMs: DEBOUNCE,
    retryMs: 1000,
    onChange: (s, info) => {
      statuses.push(s);
      if (info.conflict) conflicts.push(info.conflict);
    },
  });
  return { saver, statuses, conflicts };
}

const ok = vi.fn(async (_html: string, base: number) => ({ version: base + 1 }));

beforeEach(() => {
  vi.useFakeTimers();
  ok.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('Autosave', () => {
  it('collapses a burst of keystrokes into one save', async () => {
    const { saver, statuses } = setup(ok);
    saver.update('<p>a</p>');
    saver.update('<p>ab</p>');
    saver.update('<p>abc</p>');
    expect(saver.hasUnsavedChanges).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledWith('<p>abc</p>', 1);
    expect(saver.version).toBe(2);
    expect(saver.hasUnsavedChanges).toBe(false);
    expect(statuses).toEqual(['unsaved', 'saving', 'saved']);
  });

  it('never runs two saves at once and sends follow-up edits with the new version', async () => {
    const resolvers: (() => void)[] = [];
    const save = vi.fn(
      (_html: string, base: number) =>
        new Promise<{ version: number }>((resolve) => resolvers.push(() => resolve({ version: base + 1 }))),
    );
    const { saver } = setup(save);

    saver.update('one');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    saver.update('two');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(save).toHaveBeenCalledTimes(1); // first save still in flight

    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('two', 2); // based on the version the first save produced

    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.version).toBe(3);
    expect(saver.state).toBe('saved');
  });

  it('stops on a version conflict and resumes from the version the user picks', async () => {
    const theirs = { version: 7, contentHtml: '<p>theirs</p>' };
    const conflict: SaveError = { status: 409, message: 'conflict', retryable: false, details: { current: theirs } };
    const save = vi.fn().mockRejectedValueOnce(conflict).mockImplementation(ok);
    const { saver, statuses, conflicts } = setup(save);

    saver.update('<p>mine</p>');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saver.state).toBe('conflict');
    expect(conflicts).toEqual([theirs]);

    // Further typing must not trigger saves that would fail the same way.
    saver.update('<p>mine, more</p>');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 4);
    expect(save).toHaveBeenCalledTimes(1);

    saver.overwriteRemote(7, '<p>mine, more</p>');
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenLastCalledWith('<p>mine, more</p>', 7);
    expect(saver.version).toBe(8);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('retries network failures with backoff and keeps the newest content', async () => {
    const offline: SaveError = { status: 0, message: 'offline', retryable: true };
    const save = vi.fn().mockRejectedValueOnce(offline).mockRejectedValueOnce(offline).mockImplementation(ok);
    const { saver } = setup(save);

    saver.update('v1');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saver.state).toBe('retrying');

    await vi.advanceTimersByTimeAsync(1000); // first retry fails too
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.state).toBe('retrying');

    await vi.advanceTimersByTimeAsync(1999); // backoff doubled to 2s
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith('v1', 1);
    expect(saver.state).toBe('saved');
  });

  it('ignores updates that do not change the saved content', async () => {
    // Regression: TipTap emits "update" when editability is toggled on open,
    // which used to fire a save (403 for viewers, a needless version bump for editors).
    const statuses: SaveStatus[] = [];
    const saver = new Autosave({ version: 1, initialHtml: '<p>hi</p>', save: ok, debounceMs: DEBOUNCE, onChange: (s) => statuses.push(s) });

    saver.update('<p>hi</p>');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(ok).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);

    // Typing and then undoing back to the saved text also needs no request.
    saver.update('<p>hi!</p>');
    saver.update('<p>hi</p>');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(ok).not.toHaveBeenCalled();
    expect(saver.state).toBe('saved');
  });

  it('does not retry requests the server rejected outright', async () => {
    const forbidden: SaveError = { status: 403, message: 'view only', retryable: false };
    const save = vi.fn().mockRejectedValue(forbidden);
    const { saver } = setup(save);

    saver.update('x');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.state).toBe('error');
    expect(saver.hasUnsavedChanges).toBe(true);
  });
});
