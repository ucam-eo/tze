type EventCallback<T> = (data: T) => void;

/**
 * Minimal typed event emitter.
 *
 * @remarks
 * Events use a payload-record style: each event name maps to a
 * payload type. Listeners receive the payload as their single argument.
 *
 * @typeParam T - Event map: `{ eventName: PayloadType }`.
 */
export class EventEmitter<T extends { [K in keyof T]: unknown }> {
  private listeners = new Map<string, Set<EventCallback<unknown>>>();

  /** Subscribe to an event. */
  on<K extends keyof T & string>(
    event: K,
    callback: EventCallback<T[K]>,
  ): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
  }

  /** Unsubscribe from an event. */
  off<K extends keyof T & string>(
    event: K,
    callback: EventCallback<T[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  /** Emit an event to all subscribers. */
  protected emit<K extends keyof T & string>(
    event: K,
    data: T[K],
  ): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}
