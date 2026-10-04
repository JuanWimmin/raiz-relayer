import { Keypair, NotFoundError } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import {
  evaluateSignerAuthority,
  verifySignerAuthority,
  type SignerAccountLike,
  type SignerHorizonLike,
} from "../src/stellar/signer.js";

// ── Claves públicas de prueba (aleatorias): la cuenta y el firmante rotado ───

const admin = Keypair.random().publicKey(); // la CUENTA (deployments.admin) = su clave maestra
const newSigner = Keypair.random().publicKey(); // firmante añadido a la cuenta en la rotación
const stranger = Keypair.random().publicKey(); // una clave que no pinta nada en la cuenta

const keys = (signerPublicKey: string) => ({ adminPublicKey: admin, signerPublicKey });

/**
 * Cuenta admin tal como la devuelve Horizon: `signers` lleva SIEMPRE la clave
 * maestra (aunque pese 0) y, si se pide, el firmante añadido; `thresholds`
 * como [bajo, medio, alto].
 */
function account(opts: { master: number; added?: number; thresholds: [number, number, number] }): SignerAccountLike {
  const [low, med, high] = opts.thresholds;
  const type = "ed25519_public_key";
  const added = opts.added === undefined ? [] : [{ key: newSigner, weight: opts.added, type }];
  // Con los campos de más que trae Horizon (`type`, `high_threshold`), que la verificación ignora.
  const body = {
    signers: [...added, { key: admin, weight: opts.master, type }],
    thresholds: { low_threshold: low, med_threshold: med, high_threshold: high },
  };
  return body;
}

/** Horizon falso con guion: cada llamada consume una respuesta (la última se repite); un Error se lanza. */
function fakeHorizon(...script: unknown[]) {
  const calls: string[] = [];
  const horizon: SignerHorizonLike = {
    async loadAccount(accountId: string): Promise<SignerAccountLike> {
      calls.push(accountId);
      const next = script.length > 1 ? script.shift() : script[0];
      if (next instanceof Error) throw next;
      return next as SignerAccountLike;
    },
  };
  return { horizon, calls };
}

/** Sleep inyectable que no duerme y apunta las esperas. */
function fakeSleep() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("verifySignerAuthority — ¿la clave del relayer puede firmar por la cuenta admin?", () => {
  it("clave maestra con peso 1 y umbrales 0/0/0 → authorized (con umbral 0 basta peso ≥ 1)", async () => {
    const { horizon, calls } = fakeHorizon(account({ master: 1, thresholds: [0, 0, 0] }));
    const { sleep, sleeps } = fakeSleep();

    const r = await verifySignerAuthority(horizon, keys(admin), { sleep });
    expect(r).toEqual({ status: "authorized", weight: 1, required: 1 });
    // Se carga la CUENTA admin, una sola vez y sin esperas.
    expect(calls).toEqual([admin]);
    expect(sleeps).toEqual([]);
  });

  it("firmante añadido con peso 1, maestra en 0 y umbrales 1/1/1 (cuenta ya rotada) → authorized", async () => {
    const { horizon, calls } = fakeHorizon(account({ master: 0, added: 1, thresholds: [1, 1, 1] }));
    const r = await verifySignerAuthority(horizon, keys(newSigner));
    expect(r).toEqual({ status: "authorized", weight: 1, required: 1 });
    expect(calls).toEqual([admin]); // nunca se consulta la G… del firmante: no es una cuenta
  });

  it("a mitad de rotación (maestra 1 + firmante 1, umbrales 0/0/0) valen las dos claves", async () => {
    const midRotation = account({ master: 1, added: 1, thresholds: [0, 0, 0] });
    expect((await verifySignerAuthority(fakeHorizon(midRotation).horizon, keys(admin))).status).toBe("authorized");
    expect((await verifySignerAuthority(fakeHorizon(midRotation).horizon, keys(newSigner))).status).toBe("authorized");
  });

  it("firmante ausente de `signers` → unauthorized (not_a_signer) con la cuenta, el firmante y el porqué en el mensaje", async () => {
    const { horizon } = fakeHorizon(account({ master: 1, added: 1, thresholds: [0, 0, 0] }));
    const r = await verifySignerAuthority(horizon, keys(stranger));
    expect(r).toMatchObject({ status: "unauthorized", reason: "not_a_signer" });
    if (r.status !== "unauthorized") throw new Error("se esperaba unauthorized");
    expect(r.message).toContain(admin);
    expect(r.message).toContain(stranger);
    expect(r.message).toContain("no figura entre los firmantes");
  });

  it("peso 0: la clave maestra deshabilitada tras la rotación → unauthorized (zero_weight)", async () => {
    const { horizon } = fakeHorizon(account({ master: 0, added: 1, thresholds: [1, 1, 1] }));
    const r = await verifySignerAuthority(horizon, keys(admin));
    expect(r).toMatchObject({ status: "unauthorized", reason: "zero_weight" });
    if (r.status !== "unauthorized") throw new Error("se esperaba unauthorized");
    expect(r.message).toContain("clave maestra");
    expect(r.message).toContain("peso 0");
  });

  it("peso por debajo del umbral medio → unauthorized (below_threshold); justo en el umbral → authorized", async () => {
    const below = await verifySignerAuthority(
      fakeHorizon(account({ master: 0, added: 1, thresholds: [1, 2, 2] })).horizon,
      keys(newSigner),
    );
    expect(below).toMatchObject({ status: "unauthorized", reason: "below_threshold" });
    if (below.status !== "unauthorized") throw new Error("se esperaba unauthorized");
    expect(below.message).toContain("su peso (1)");
    expect(below.message).toContain("medio 2");

    const exact = await verifySignerAuthority(
      fakeHorizon(account({ master: 0, added: 2, thresholds: [1, 2, 2] })).horizon,
      keys(newSigner),
    );
    expect(exact).toEqual({ status: "authorized", weight: 2, required: 2 });
  });

  it("el umbral ALTO no cuenta (el relayer no hace set_options) y el BAJO sí si supera al medio (la tx se valida contra él)", async () => {
    // alto 5: irrelevante para payment / invoke_host_function.
    const highOnly = account({ master: 0, added: 1, thresholds: [1, 1, 5] });
    expect((await verifySignerAuthority(fakeHorizon(highOnly).horizon, keys(newSigner))).status).toBe("authorized");
    // bajo 2 > medio 1 (cuenta rara): la red daría txBadAuth con peso 1.
    const lowAboveMed = account({ master: 0, added: 1, thresholds: [2, 1, 2] });
    expect(await verifySignerAuthority(fakeHorizon(lowAboveMed).horizon, keys(newSigner))).toMatchObject({
      status: "unauthorized",
      reason: "below_threshold",
    });
  });

  it("Horizon caído → unknown tras 3 intentos con backoff corto (1 s, 2 s); nunca lanza", async () => {
    const { horizon, calls } = fakeHorizon(new Error("fetch failed host-interno"));
    const { sleep, sleeps } = fakeSleep();
    const warn = vi.fn();

    const r = await verifySignerAuthority(horizon, keys(newSigner), { sleep, logger: { warn } as unknown as Logger });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") throw new Error("se esperaba unknown");
    expect(r.message).toContain(admin);
    expect(r.message).toContain(newSigner);
    expect(r.message).not.toContain("host-interno"); // el texto crudo de red solo va al log
    expect(calls).toEqual([admin, admin, admin]);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ stage: "horizon.loadAccount", attempt: 1, attempts: 3 });
  });

  it("un fallo transitorio de Horizon se reintenta y la respuesta posterior decide", async () => {
    const { horizon, calls } = fakeHorizon(new Error("ETIMEDOUT"), account({ master: 0, added: 1, thresholds: [1, 1, 1] }));
    const { sleep, sleeps } = fakeSleep();
    const r = await verifySignerAuthority(horizon, keys(newSigner), { sleep });
    expect(r.status).toBe("authorized");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("`attempts: 1` (lo que usa /v1/health) → un solo intento y sin esperas", async () => {
    const { horizon, calls } = fakeHorizon(new Error("down"));
    const { sleep, sleeps } = fakeSleep();
    const r = await verifySignerAuthority(horizon, keys(newSigner), { attempts: 1, sleep });
    expect(r.status).toBe("unknown");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("la cuenta admin no existe (404 de Horizon) → unauthorized (account_not_found), definitivo: sin reintentos", async () => {
    const { horizon, calls } = fakeHorizon(new NotFoundError("Not Found", { status: 404 }));
    const { sleep, sleeps } = fakeSleep();
    const r = await verifySignerAuthority(horizon, keys(newSigner), { sleep });
    expect(r).toMatchObject({ status: "unauthorized", reason: "account_not_found" });
    if (r.status !== "unauthorized") throw new Error("se esperaba unauthorized");
    expect(r.message).toContain(admin);
    expect(r.message).toContain("no existe en la red");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("respuesta sin `signers`/`thresholds` o con tipos raros → unknown, NUNCA authorized", async () => {
    const ok = account({ master: 0, added: 1, thresholds: [1, 1, 1] });
    const malformed: unknown[] = [
      {},
      null,
      { signers: ok.signers },
      { thresholds: ok.thresholds },
      { signers: ok.signers, thresholds: {} },
      { signers: ok.signers, thresholds: { low_threshold: 1 } },
      { signers: ok.signers, thresholds: { low_threshold: "1", med_threshold: "1" } },
      { signers: "no-es-un-array", thresholds: ok.thresholds },
      { signers: [{ key: newSigner, weight: "1" }], thresholds: ok.thresholds },
      { signers: [{ key: newSigner }], thresholds: ok.thresholds },
    ];
    for (const body of malformed) {
      const { horizon } = fakeHorizon(body);
      const r = await verifySignerAuthority(horizon, keys(newSigner), { attempts: 1 });
      expect(r.status, JSON.stringify(body)).toBe("unknown");
    }
  });
});

describe("evaluateSignerAuthority — decisión pura sobre una cuenta ya cargada", () => {
  it("el peso exigido es max(1, bajo, medio) y el resultado lo informa", () => {
    const r = evaluateSignerAuthority(account({ master: 0, added: 3, thresholds: [1, 2, 3] }), keys(newSigner));
    expect(r).toEqual({ status: "authorized", weight: 3, required: 2 });
  });

  it("un firmante NO maestro con peso 0 no se confunde con la maestra en el mensaje", () => {
    const r = evaluateSignerAuthority(account({ master: 1, added: 0, thresholds: [0, 0, 0] }), keys(newSigner));
    expect(r).toMatchObject({ status: "unauthorized", reason: "zero_weight" });
    if (r.status !== "unauthorized") throw new Error("se esperaba unauthorized");
    expect(r.message).not.toContain("clave maestra");
    expect(r.message).toContain("peso 0");
  });
});
