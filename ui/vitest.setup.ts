import { vi } from 'vitest';

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe = vi.fn((target: Element) => {
    if (target instanceof HTMLElement) {
      if (target.clientWidth === 0) {
        Object.defineProperty(target, 'clientWidth', { configurable: true, value: 1024 });
      }
      if (target.clientHeight === 0) {
        Object.defineProperty(target, 'clientHeight', { configurable: true, value: 768 });
      }
    }
    this.callback([], this);
  });
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);
