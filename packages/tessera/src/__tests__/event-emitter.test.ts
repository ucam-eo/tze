import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../event-emitter.js';

interface TestEvents {
  ping: string;
  count: number;
  empty: undefined;
}

describe('EventEmitter', () => {
  it('calls listener with correct payload', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb = vi.fn();
    emitter.on('ping', cb);
    emitter['emit']('ping', 'hello');
    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    emitter.on('count', cb1);
    emitter.on('count', cb2);
    emitter['emit']('count', 42);
    expect(cb1).toHaveBeenCalledWith(42);
    expect(cb2).toHaveBeenCalledWith(42);
  });

  it('removes listener with off()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb = vi.fn();
    emitter.on('ping', cb);
    emitter.off('ping', cb);
    emitter['emit']('ping', 'ignored');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    expect(() => emitter['emit']('ping', 'test')).not.toThrow();
  });

  it('isolates events by name', () => {
    const emitter = new EventEmitter<TestEvents>();
    const pingCb = vi.fn();
    const countCb = vi.fn();
    emitter.on('ping', pingCb);
    emitter.on('count', countCb);
    emitter['emit']('ping', 'hello');
    expect(pingCb).toHaveBeenCalledOnce();
    expect(countCb).not.toHaveBeenCalled();
  });
});
