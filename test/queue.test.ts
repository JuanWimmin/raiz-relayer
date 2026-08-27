import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayerError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { SerialQueue } from "../src/queue.js";

const logger = createLogger("silent");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Vacía la cola de microtareas sin avanzar timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function relayerError(p: Promise<unknown>): Promise<RelayerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RelayerError) return e;
    throw new Error(`se esperaba RelayerError, llegó ${String(e)}`);
  }
  throw new Error("se esperaba un rechazo");
}

describe("SerialQueue", () => {
  beforeEach(() => {
    // Timers falsos: el timeout de job nunca duerme de verdad.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ejecuta en orden FIFO y con exclusión mutua (el 2º no empieza hasta que acaba el 1º)", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 60_000, logger, now: () => Date.now() });
    const started: string[] = [];
    const finished: string[] = [];
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    const p1 = q.enqueue(async () => {
      started.push("a");
      await gate1.promise;
      finished.push("a");
      return "A";
    }, "a");
    const p2 = q.enqueue(async () => {
      started.push("b");
      await gate2.promise;
      finished.push("b");
      return "B";
    }, "b");
    const p3 = q.enqueue(async () => {
      started.push("c");
      finished.push("c");
      return "C";
    }, "c");

    expect(q.pending()).toBe(3);
    await flush();
    expect(started).toEqual(["a"]);

    gate1.resolve();
    await flush();
    expect(finished).toEqual(["a"]);
    expect(started).toEqual(["a", "b"]);
    expect(q.pending()).toBe(2);

    gate2.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    expect(finished).toEqual(["a", "b", "c"]);

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(["A", "B", "C"]);
    expect(q.pending()).toBe(0);
  });

  it("un job que falla no bloquea al siguiente", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 60_000, logger });
    const p1 = q.enqueue(async () => {
      throw new Error("boom");
    });
    const p2 = q.enqueue(async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(q.pending()).toBe(0);
  });

  it("un throw síncrono del job se convierte en rechazo y la cola sigue", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 60_000, logger });
    const p1 = q.enqueue(() => {
      throw new Error("sync");
    });
    const p2 = q.enqueue(async () => 2);
    await expect(p1).rejects.toThrow("sync");
    await expect(p2).resolves.toBe(2);
  });

  it("rechaza inmediatamente con QUEUE_FULL al alcanzar el cap", async () => {
    const q = new SerialQueue({ cap: 2, jobTimeoutMs: 60_000, logger });
    const gate = deferred<void>();
    const p1 = q.enqueue(() => gate.promise);
    const p2 = q.enqueue(() => gate.promise);
    expect(q.pending()).toBe(2);

    const e = await relayerError(q.enqueue(async () => "no"));
    expect(e.code).toBe("QUEUE_FULL");
    expect(e.http).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.details).toMatchObject({ pending: 2, cap: 2 });
    // El rechazo no ocupa sitio.
    expect(q.pending()).toBe(2);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(q.pending()).toBe(0);
    await expect(q.enqueue(async () => "si")).resolves.toBe("si");
  });

  it("assertCapacity lanza el MISMO QUEUE_FULL que enqueue al llegar al cap y no ocupa plaza", async () => {
    const q = new SerialQueue({ cap: 2, jobTimeoutMs: 60_000, logger });
    expect(() => q.assertCapacity("faucet")).not.toThrow();
    expect(q.pending()).toBe(0);

    const gate = deferred<void>();
    const p1 = q.enqueue(() => gate.promise);
    const p2 = q.enqueue(() => gate.promise);
    expect(q.pending()).toBe(2);

    let thrown: unknown;
    try {
      q.assertCapacity("faucet");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RelayerError);
    const a = thrown as RelayerError;
    const b = await relayerError(q.enqueue(async () => "no", "faucet"));
    expect(a.code).toBe("QUEUE_FULL");
    expect(a.http).toBe(503);
    expect(a.retryable).toBe(true);
    expect(a.message).toBe(b.message);
    expect(a.details).toEqual(b.details);
    expect(a.details).toEqual({ pending: 2, cap: 2 });
    // Ni assertCapacity ni el enqueue rechazado ocupan sitio.
    expect(q.pending()).toBe(2);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(q.pending()).toBe(0);
    expect(() => q.assertCapacity()).not.toThrow();
  });

  it("timeout → TX_TIMEOUT con txHash null y la cola continúa con el siguiente", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 1_000, logger });
    const zombie = deferred<string>();
    const started: string[] = [];

    const p1 = q.enqueue(() => {
      started.push("zombie");
      return zombie.promise;
    }, "zombie");
    const p2 = q.enqueue(async () => {
      started.push("next");
      return "next-ok";
    }, "next");

    await flush();
    expect(started).toEqual(["zombie"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(started).toEqual(["zombie"]);

    await vi.advanceTimersByTimeAsync(1);
    const e = await relayerError(p1);
    expect(e.code).toBe("TX_TIMEOUT");
    expect(e.retryable).toBe(true);
    expect(e.details).toEqual({ txHash: null });

    await flush();
    expect(started).toEqual(["zombie", "next"]);
    await expect(p2).resolves.toBe("next-ok");
    expect(q.pending()).toBe(0);

    // El zombi termina más tarde sin romper nada (ni unhandledRejection).
    zombie.reject(new Error("tarde"));
    await flush();
    expect(q.pending()).toBe(0);
  });

  it("un job que termina antes del timeout no deja el timer vivo", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 1_000, logger });
    await expect(q.enqueue(async () => "rapido")).resolves.toBe("rapido");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drain() resuelve cuando no queda nada, incluidos jobs encolados después de llamarlo", async () => {
    const q = new SerialQueue({ cap: 10, jobTimeoutMs: 60_000, logger });
    const gate = deferred<void>();
    const order: string[] = [];
    void q.enqueue(async () => {
      await gate.promise;
      order.push("a");
    });
    void q.enqueue(async () => {
      order.push("b");
    });

    let drained = false;
    const d = q.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    // Se encola uno más mientras drenamos: drain debe esperarlo también.
    void q.enqueue(async () => {
      order.push("c");
    });

    gate.resolve();
    await flush();
    await d;
    expect(drained).toBe(true);
    expect(order).toEqual(["a", "b", "c"]);
    expect(q.pending()).toBe(0);
  });

  it("drain() con la cola vacía resuelve de inmediato", async () => {
    const q = new SerialQueue({ cap: 1, jobTimeoutMs: 1_000, logger });
    await expect(q.drain()).resolves.toBeUndefined();
  });

  it("valida las opciones del constructor", () => {
    expect(() => new SerialQueue({ cap: 0, jobTimeoutMs: 1000 })).toThrow();
    expect(() => new SerialQueue({ cap: 1, jobTimeoutMs: 0 })).toThrow();
  });
});
