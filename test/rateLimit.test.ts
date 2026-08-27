import { describe, expect, it } from "vitest";
import { DAY_MS, RateLimiter, makeLimits } from "../src/rateLimit.js";

/** Reloj manual: `clock.now` es la función inyectable, `advance` la mueve. */
function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const TEN_MIN = 10 * 60_000;
// 2026-08-27T23:59:00Z, en ms
const NEAR_MIDNIGHT = Date.UTC(2026, 7, 27, 23, 59, 0);

describe("RateLimiter — ventana fija por address", () => {
  it("2ª request en <10 min → allowed:false con retryAfterMs > 0; tras 10 min → allowed", () => {
    const clock = fakeClock(1_000_000);
    const rl = new RateLimiter({ now: clock.now });

    expect(rl.consume("faucet:addr", "GADDR", 1, TEN_MIN)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });

    clock.advance(60_000);
    const second = rl.check("faucet:addr", "GADDR", 1, TEN_MIN);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
    expect(second.retryAfterMs).toBe(TEN_MIN - 60_000);

    const consumed = rl.consume("faucet:addr", "GADDR", 1, TEN_MIN);
    expect(consumed.allowed).toBe(false);
    expect(consumed.retryAfterMs).toBeGreaterThan(0);

    clock.advance(TEN_MIN - 60_000);
    expect(rl.check("faucet:addr", "GADDR", 1, TEN_MIN).allowed).toBe(true);
    expect(rl.consume("faucet:addr", "GADDR", 1, TEN_MIN).allowed).toBe(true);
  });

  it("la ventana arranca en el primer hit (fija, no deslizante) y las keys son independientes", () => {
    const clock = fakeClock(5_000);
    const rl = new RateLimiter({ now: clock.now });
    rl.consume("faucet:addr", "A", 1, TEN_MIN);
    clock.advance(TEN_MIN - 1);
    expect(rl.check("faucet:addr", "A", 1, TEN_MIN).allowed).toBe(false);
    expect(rl.check("faucet:addr", "B", 1, TEN_MIN).allowed).toBe(true);
    clock.advance(1);
    expect(rl.check("faucet:addr", "A", 1, TEN_MIN).allowed).toBe(true);
  });
});

describe("RateLimiter — ventana diaria UTC", () => {
  it("se reinicia al cruzar las 00:00 UTC", () => {
    const clock = fakeClock(NEAR_MIDNIGHT);
    const rl = new RateLimiter({ now: clock.now });

    expect(rl.consume("faucet:day", "global", 2, DAY_MS).allowed).toBe(true);
    expect(rl.consume("faucet:day", "global", 2, DAY_MS).allowed).toBe(true);
    const full = rl.check("faucet:day", "global", 2, DAY_MS);
    expect(full.allowed).toBe(false);
    // Faltan exactamente 60 s para medianoche
    expect(full.retryAfterMs).toBe(60_000);

    clock.advance(59_999);
    expect(rl.check("faucet:day", "global", 2, DAY_MS).allowed).toBe(false);

    clock.advance(1); // 00:00:00 UTC del día siguiente
    expect(rl.snapshot("faucet:day", "global", 2, DAY_MS)).toEqual({ used: 0, remaining: 2, resetsInMs: DAY_MS });
    expect(rl.consume("faucet:day", "global", 2, DAY_MS)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
  });
});

describe("RateLimiter — check / consume / snapshot", () => {
  it("check no consume", () => {
    const rl = new RateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) expect(rl.check("b", "k", 1, TEN_MIN).allowed).toBe(true);
    expect(rl.snapshot("b", "k", 1, TEN_MIN).used).toBe(0);
    expect(rl.consume("b", "k", 1, TEN_MIN).allowed).toBe(true);
  });

  it("consume incrementa hasta max y luego no incrementa más", () => {
    const rl = new RateLimiter({ now: () => 0 });
    expect(rl.consume("b", "k", 3, TEN_MIN)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(rl.consume("b", "k", 3, TEN_MIN)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(rl.consume("b", "k", 3, TEN_MIN)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(rl.consume("b", "k", 3, TEN_MIN).allowed).toBe(false);
    expect(rl.consume("b", "k", 3, TEN_MIN).allowed).toBe(false);
    expect(rl.snapshot("b", "k", 3, TEN_MIN).used).toBe(3);
  });

  it("snapshot refleja used/remaining/resetsInMs", () => {
    const clock = fakeClock(100);
    const rl = new RateLimiter({ now: clock.now });
    expect(rl.snapshot("b", "k", 5, TEN_MIN)).toEqual({ used: 0, remaining: 5, resetsInMs: 0 });
    rl.consume("b", "k", 5, TEN_MIN);
    rl.consume("b", "k", 5, TEN_MIN);
    clock.advance(1_000);
    expect(rl.snapshot("b", "k", 5, TEN_MIN)).toEqual({ used: 2, remaining: 3, resetsInMs: TEN_MIN - 1_000 });
  });

  it("limpia entradas caducadas de forma perezosa (sin timers)", () => {
    const clock = fakeClock(0);
    const rl = new RateLimiter({ now: clock.now });
    for (let i = 0; i < 300; i++) rl.consume("b", `k${i}`, 1, 1_000);
    expect(rl.size()).toBe(300);
    clock.advance(2_000);
    // Tocar una entrada caducada la borra; el barrido periódico borra el resto
    for (let i = 0; i < 300; i++) rl.consume("b", `x${i}`, 1, 1_000);
    expect(rl.size()).toBeLessThanOrEqual(300);
    expect(rl.check("b", "k0", 1, 1_000).allowed).toBe(true);
  });
});

describe("makeLimits", () => {
  const rates = {
    faucetPerAddressWindowMs: TEN_MIN,
    faucetDaily: 2,
    registerDaily: 20,
    mintDaily: 20,
    vaultDaily: 20,
    perIpPerMinute: 60,
  };

  it("faucetAddress es por address; faucetDaily es global", () => {
    const clock = fakeClock(NEAR_MIDNIGHT);
    const limits = makeLimits({ rates }, new RateLimiter({ now: clock.now }));

    expect(limits.faucetAddress("A").consume().allowed).toBe(true);
    expect(limits.faucetDaily().consume().allowed).toBe(true);
    expect(limits.faucetAddress("A").check().allowed).toBe(false);
    expect(limits.faucetAddress("B").check().allowed).toBe(true);

    expect(limits.faucetDaily().consume().allowed).toBe(true);
    expect(limits.faucetDaily().check().allowed).toBe(false);
    expect(limits.faucetDaily().snapshot()).toEqual({ used: 2, remaining: 0, resetsInMs: 60_000 });

    // Los diarios no se pisan entre sí
    expect(limits.registerDaily().snapshot().used).toBe(0);
    expect(limits.mintDaily().check().allowed).toBe(true);
    expect(limits.vaultDaily().check().allowed).toBe(true);
  });

  it("expone un nombre legible para el mensaje del 429", () => {
    const limits = makeLimits({ rates });
    expect(limits.faucetAddress("A").name).toContain("address");
    expect(limits.faucetDaily().name).toContain("faucet");
  });
});
