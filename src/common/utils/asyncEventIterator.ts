/**
 * Convert event emitter subscription to async iterator.
 *
 * Handles the common pattern of:
 * 1. Subscribe to events
 * 2. Yield events as async iterator
 * 3. Unsubscribe on cleanup
 *
 * Usage:
 * ```ts
 * yield* asyncEventIterator<MyEvent>(
 *   (handler) => emitter.on('event', handler),
 *   (handler) => emitter.off('event', handler)
 * );
 * ```
 *
 * Or with initialValue for immediate first yield:
 * ```ts
 * yield* asyncEventIterator<MyState>(
 *   (handler) => service.onChange(handler),
 *   (handler) => service.offChange(handler),
 *   { initialValue: await service.getState() }
 * );
 * ```
 */
export async function* asyncEventIterator<T>(
  subscribe: (handler: (value: T) => void) => void,
  unsubscribe: (handler: (value: T) => void) => void,
  options?: { initialValue?: T }
): AsyncGenerator<T> {
  const queue: T[] = [];
  let resolveNext: ((value: T) => void) | null = null;
  let ended = false;

  const handler = (value: T) => {
    if (ended) return;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  subscribe(handler);

  try {
    // Yield initial value if provided
    if (options?.initialValue !== undefined) {
      yield options.initialValue;
    }

    while (!ended) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        yield await new Promise<T>((resolve) => {
          resolveNext = resolve;
        });
      }
    }
  } finally {
    ended = true;
    unsubscribe(handler);
  }
}

/**
 * Create an async event queue that can be pushed to from event handlers.
 *
 * This is useful when events don't directly yield values but trigger
 * async state fetches.
 *
 * Usage:
 * ```ts
 * const queue = createAsyncEventQueue<State>();
 *
 * const onChange = async () => {
 *   queue.push(await fetchState());
 * };
 *
 * emitter.on('change', onChange);
 * try {
 *   yield* queue.iterate();
 * } finally {
 *   emitter.off('change', onChange);
 * }
 * ```
 */
export function createAsyncEventQueue<T>(): {
  push: (value: T) => void;
  iterate: () => AsyncGenerator<T>;
  end: () => void;
} {
  const queue: T[] = [];
  let resolveNext: ((value: T) => void) | null = null;
  let ended = false;

  const push = (value: T) => {
    if (ended) return;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  async function* iterate(): AsyncGenerator<T> {
    while (!ended) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        yield await new Promise<T>((resolve) => {
          resolveNext = resolve;
        });
      }
    }
  }

  const end = () => {
    ended = true;
    // Wake up the iterator if it's waiting
    if (resolveNext) {
      // This will never be yielded since ended=true stops the loop
      resolveNext(undefined as T);
    }
  };

  return { push, iterate, end };
}
