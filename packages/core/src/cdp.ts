/**
 * A minimal DevTools Protocol client over Node's own WebSocket.
 *
 * Per ADR 0008 the engine speaks to the socket directly rather than through
 * Playwright, because `HeadlessExperimental.beginFrame` is gated behind a flag
 * that can only be set when the target is created and Playwright creates its
 * own targets.
 */
import { RecordError } from "./errors.js";

type Reply = { resolve: (result: Record<string, unknown>) => void; reject: (failure: Error) => void };
type Waiter = { resolve: (params: Record<string, unknown>) => void; reject: (failure: Error) => void };

export type Cdp = {
  /** Sends a command and resolves with its result, or rejects with its error. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** Resolves with the next occurrence of an event. Subscribe before provoking it. */
  once(event: string): Promise<Record<string, unknown>>;
  close(): void;
};

export async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);

  const pending = new Map<number, Reply>();
  const waiting = new Map<string, Waiter[]>();
  let nextId = 0;
  let closed: Error | undefined;

  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message: string };
    };

    if (message.id !== undefined) {
      const reply = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reply?.reject(new RecordError(`the browser rejected a command: ${message.error.message}`));
      } else {
        reply?.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method !== undefined) {
      for (const waiter of waiting.get(message.method) ?? []) {
        waiter.resolve(message.params ?? {});
      }
      waiting.delete(message.method);
    }
  });

  // Neither a command nor an event can ever be answered once the socket is
  // gone, so everything outstanding fails loudly instead of hanging.
  const abandon = (why: string) => {
    closed ??= new RecordError(`the browser disconnected: ${why}`);
    for (const outstanding of [...pending.values(), ...[...waiting.values()].flat()]) {
      outstanding.reject(closed);
    }
    pending.clear();
    waiting.clear();
  };
  socket.addEventListener("close", () => abandon("the connection closed"));
  socket.addEventListener("error", () => abandon("the connection failed"));

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new RecordError(`could not reach ${url}`)), {
      once: true,
    });
  });

  return {
    send(method, params = {}, sessionId) {
      if (closed) {
        return Promise.reject(closed);
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    once(event) {
      if (closed) {
        return Promise.reject(closed);
      }
      return new Promise((resolve, reject) => {
        waiting.set(event, [...(waiting.get(event) ?? []), { resolve, reject }]);
      });
    },
    close() {
      socket.close();
    },
  };
}
