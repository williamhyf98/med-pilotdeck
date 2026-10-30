import { describe, expect, it, vi } from 'vitest';
import { SmoothTextStream } from './streamSmoother';

function createManualFrameScheduler(onFrame?: () => void) {
  let nextId = 1;
  const queue: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];

  return {
    scheduleFrame(callback: () => void): number {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback, cancelled: false });
      return id;
    },
    cancelFrame(id: number) {
      const item = queue.find((entry) => entry.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) {
        onFrame?.();
        item.callback();
      }
    },
    drain(limit = 80) {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        this.runNext();
        count += 1;
      }
      return count;
    },
    get size() {
      return queue.filter((item) => !item.cancelled).length;
    },
  };
}

describe('SmoothTextStream', () => {
  it('buffers bursts and renders them gradually without dropping or reordering text', () => {
    const scheduler = createManualFrameScheduler();
    const emitted: string[] = [];
    const first = 'abcdefghijklmnopqrstuvwxyz '.repeat(4);
    const second = '补充内容。';
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    stream.append(first);
    expect(emitted).toEqual([]);
    expect(scheduler.size).toBe(1);
    scheduler.runNext();
    expect(emitted[0].length).toBeGreaterThan(0);
    expect(emitted[0].length).toBeLessThan(first.length);
    stream.append(second);
    expect(scheduler.size).toBe(1);
    scheduler.drain(200);

    expect(emitted.at(-1)).toBe(first + second);
    expect(stream.getSnapshot().pendingChars).toBe(0);
    expect(scheduler.size).toBe(0);
    for (let i = 1; i < emitted.length; i += 1) {
      expect(emitted[i].startsWith(emitted[i - 1])).toBe(true);
      expect(emitted[i].length - emitted[i - 1].length).toBeLessThanOrEqual(4);
    }
  });

  it('pauses without emitting queued text and resumes without losing content', () => {
    const scheduler = createManualFrameScheduler();
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    stream.append('第一段内容');
    stream.pause();
    scheduler.drain();
    stream.append('，第二段内容');
    expect(emitted).toEqual([]);
    stream.resume();
    scheduler.drain();
    expect(emitted.at(-1)).toBe('第一段内容，第二段内容');
    expect(stream.getSnapshot().pendingChars).toBe(0);
  });

  it('drains buffered text before finalizing exactly once', () => {
    const scheduler = createManualFrameScheduler();
    const emitted: string[] = [];
    const completed: string[] = [];
    const text = '诊疗建议。'.repeat(20);
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      finalize: () => completed.push(emitted.at(-1) ?? ''),
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const onDrainComplete = vi.fn();
    stream.onDrainComplete = onDrainComplete;
    stream.append(text);
    stream.drain();
    scheduler.runNext();
    expect(emitted[0].length).toBeLessThan(text.length);
    expect(completed).toEqual([]);
    scheduler.drain();
    expect(completed).toEqual([text]);
    expect(onDrainComplete).toHaveBeenCalledTimes(1);
    expect(scheduler.size).toBe(0);
  });

  it('flushes all buffered content and finalizes immediately', () => {
    const scheduler = createManualFrameScheduler();
    const emitted: string[] = [];
    let finalized = 0;
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      finalize: () => { finalized += 1; },
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    stream.append('streaming output');
    stream.flush(true);
    scheduler.drain();
    expect(emitted).toEqual(['streaming output']);
    expect(finalized).toBe(1);
    expect(stream.getSnapshot().targetLength).toBe(0);
    expect(stream.getSnapshot().renderedLength).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  it('keeps streaming with a fallback timer and stops emitting after cancellation', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      fallbackFrameMs: 10,
    });
    try {
      stream.append('abcdefghijklmnopqrstuvwxyz '.repeat(4));
      expect(emitted).toEqual([]);
      // The fallback fires before the normal 16ms frame timer.
      vi.advanceTimersByTime(10);
      expect(emitted).toHaveLength(1);
      vi.advanceTimersByTime(10);
      expect(emitted).toHaveLength(2);
      expect(emitted[1].length).toBeGreaterThan(emitted[0].length);
      stream.cancel();
      vi.advanceTimersByTime(100);
      expect(emitted).toHaveLength(2);
      expect(stream.getSnapshot().isScheduled).toBe(false);
    } finally {
      stream.cancel();
      vi.useRealTimers();
    }
  });
});
