import { describe, expect, it, vi } from "vitest";
import { RelayerError, isRelayerError } from "../src/errors.js";
import { IdempotencyCache, hashBody, isCacheableFailure } from "../src/idempotency.js";

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

  describe("TX_TIMEOUT con txHash (tx firmada en vuelo)", () => {
    const TX_HASH = "cd".repeat(32);
    const timeoutWithHash = () =>
      new RelayerError("TX_TIMEOUT", "deadline vencido con tx en vuelo", { txHash: TX_HASH });

    it("isCacheableFailure: solo TX_TIMEOUT con txHash string no vacío", () => {
      expect(isCacheableFailure(timeoutWithHash())).toBe(true);
      expect(isCacheableFailure(new RelayerError("TX_TIMEOUT", "sin hash", { txHash: null }))).toBe(false);
      expect(isCacheableFailure(new RelayerError("TX_TIMEOUT", "sin details"))).toBe(false);
      expect(isCacheableFailure(new RelayerError("TX_TIMEOUT", "hash vacío", { txHash: "" }))).toBe(false);
      expect(isCacheableFailure(new RelayerError("RATE_LIMITED", "cupo", { txHash: TX_HASH }))).toBe(false);
      expect(isCacheableFailure(new Error("boom"))).toBe(false);
      expect(isCacheableFailure(undefined)).toBe(false);
    });

    it("SE cachea: el segundo run con la misma key no llama a fn y rechaza con el MISMO error", async () => {
      const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
      const h = hashBody({ barrioId: "11".repeat(32), amountStroops: "20000000" });
      const err = timeoutWithHash();
      const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(err).mockResolvedValueOnce("re-firmada");

      await expect(cache.run("vault-deposit", "k", h, fn)).rejects.toBe(err);
      expect(cache.size()).toBe(1);

      // Reintento con la misma key: no re-firma, devuelve el mismo hash.
      await expect(cache.run("vault-deposit", "k", h, fn)).rejects.toSatisfy(
        (e: unknown) => e === err && isRelayerError(e) && e.code === "TX_TIMEOUT" && e.details?.txHash === TX_HASH,
      );
      expect(fn).toHaveBeenCalledTimes(1);

      // Misma key con body distinto sigue siendo mismatch, no el error cacheado.
      await expect(cache.run("vault-deposit", "k", hashBody({ otro: 1 }), fn)).rejects.toSatisfy(
        (e: unknown) => isRelayerError(e) && e.code === "IDEMPOTENCY_MISMATCH",
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("el rechazo cacheado expira con la misma TTL que un éxito", async () => {
      let t = 0;
      const cache = new IdempotencyCache({ ttlMs: 1_000, now: () => t });
      const h = hashBody({});
      const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(timeoutWithHash()).mockResolvedValueOnce("ok");
      await expect(cache.run("s", "k", h, fn)).rejects.toSatisfy((e: unknown) => isRelayerError(e) && e.code === "TX_TIMEOUT");
      t = 999;
      await expect(cache.run("s", "k", h, fn)).rejects.toSatisfy((e: unknown) => isRelayerError(e) && e.code === "TX_TIMEOUT");
      expect(fn).toHaveBeenCalledTimes(1);
      t = 1_000;
      await expect(cache.run("s", "k", h, fn)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("TX_TIMEOUT con txHash null NO se cachea: fn se llama de nuevo", async () => {
      const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
      const h = hashBody({});
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new RelayerError("TX_TIMEOUT", "la cola venció antes de enviar", { txHash: null }))
        .mockResolvedValueOnce("ok");
      await expect(cache.run("s", "k", h, fn)).rejects.toSatisfy((e: unknown) => isRelayerError(e) && e.code === "TX_TIMEOUT");
      expect(cache.size()).toBe(0);
      await expect(cache.run("s", "k", h, fn)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("otro RelayerError (RATE_LIMITED) NO se cachea aunque traiga txHash", async () => {
      const cache = new IdempotencyCache({ ttlMs: 60_000, now: () => 0 });
      const h = hashBody({});
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new RelayerError("RATE_LIMITED", "cupo agotado", { retryAfterSeconds: 5, txHash: TX_HASH }))
        .mockResolvedValueOnce("ok");
      await expect(cache.run("s", "k", h, fn)).rejects.toSatisfy((e: unknown) => isRelayerError(e) && e.code === "RATE_LIMITED");
      expect(cache.size()).toBe(0);
      await expect(cache.run("s", "k", h, fn)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
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
