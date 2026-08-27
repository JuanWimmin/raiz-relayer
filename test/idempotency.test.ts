import { describe, expect, it, vi } from "vitest";
import { isRelayerError } from "../src/errors.js";
import { IdempotencyCache, hashBody } from "../src/idempotency.js";

/** Promesa que se resuelve desde fuera (para simular un job en vuelo). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("hashBody", () => {
  it("es estable ante el orden de las claves y distinto para bodies distintos", () => {
    expect(hashBody({ a: 1, b: { c: [1, 2] } })).toBe(hashBody({ b: { c: [1, 2] }, a: 1 }));
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
    expect(hashBody(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("IdempotencyCache", () => {
  it("reutiliza la promesa en vuelo: fn se llama 1 vez para 2 llamadas concurrentes", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const h = hashBody({ x: 1 });

    const p1 = cache.run("faucet", "k1", h, fn);
    const p2 = cache.run("faucet", "k1", h, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve("tx");
    await expect(p1).resolves.toBe("tx");
    await expect(p2).resolves.toBe("tx");

    // Ya resuelta, sigue cacheada
    await expect(cache.run("faucet", "k1", h, fn)).resolves.toBe("tx");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("misma key con body distinto → IDEMPOTENCY_MISMATCH", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
    await cache.run("faucet", "k1", hashBody({ x: 1 }), async () => "a");
    await expect(cache.run("faucet", "k1", hashBody({ x: 2 }), async () => "b")).rejects.toSatisfy(
      (e: unknown) => isRelayerError(e) && e.code === "IDEMPOTENCY_MISMATCH" && e.http === 422,
    );
  });

  it("el scope separa las keys", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
    const h = hashBody({ x: 1 });
    await expect(cache.run("faucet", "k1", h, async () => "a")).resolves.toBe("a");
    await expect(cache.run("mint", "k1", h, async () => "b")).resolves.toBe("b");
  });

  it("expira por TTL", async () => {
    let t = 0;
    const cache = new IdempotencyCache({ ttlMs: 1_000, now: () => t });
    const fn = vi.fn(async () => "v");
    const h = hashBody({});
    await cache.run("s", "k", h, fn);
    t = 999;
    await cache.run("s", "k", h, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    t = 1_000;
    await cache.run("s", "k", h, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("un error no se cachea: el siguiente intento vuelve a ejecutar fn", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
    const h = hashBody({});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(cache.run("s", "k", h, fn)).rejects.toThrow("boom");
    expect(cache.size()).toBe(0);
    await expect(cache.run("s", "k", h, fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("un throw síncrono de fn se trata como rechazo", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
    await expect(
      cache.run("s", "k", hashBody({}), () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(cache.size()).toBe(0);
  });

  it("LRU por inserción: al superar max se expulsa la más antigua", async () => {
    const cache = new IdempotencyCache({ ttlMs: 60_000, max: 2, now: () => 0 });
    const h = hashBody({});
    const fn = vi.fn(async () => "v");
    await cache.run("s", "k1", h, fn);
    await cache.run("s", "k2", h, fn);
    await cache.run("s", "k3", h, fn);
    expect(cache.size()).toBe(2);
    await cache.run("s", "k1", h, fn); // expulsada → se vuelve a ejecutar
    expect(fn).toHaveBeenCalledTimes(4);
    await cache.run("s", "k3", h, fn); // sigue viva
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
