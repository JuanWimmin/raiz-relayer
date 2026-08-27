import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RelayerError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { HEALTH_UPSTREAM_TIMEOUT_MS } from "../src/routes/health.js";
import type { FaucetResult, ServiceHooks, StellarService, SubmitResult } from "../src/types.js";

// ─── Config de test: admin aleatorio + deployments temporal ──────────────────

const TEST_KEY = "test-key-0123456789abcdef";
const admin = Keypair.random();

const baseDeployments = JSON.parse(
  readFileSync(new URL("../config/deployments.testnet.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const tmpDir = mkdtempSync(join(tmpdir(), "raiz-relayer-test-"));
const deploymentsFile = join(tmpDir, "deployments.json");
writeFileSync(deploymentsFile, JSON.stringify({ ...baseDeployments, admin: admin.publicKey() }));

function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NETWORK: "testnet",
    RELAYER_ADMIN_SECRET: admin.secret(),
    RELAYER_APP_KEY: TEST_KEY,
    DEPLOYMENTS_FILE: deploymentsFile,
    RATE_PER_IP_PER_MINUTE: "100000",
    ...extra,
  };
}

// ─── Servicio falso ──────────────────────────────────────────────────────────

const TX: SubmitResult = { txHash: "ab".repeat(32), ledger: 4_365_434 };
const FAUCET_TX: FaucetResult = {
  ...TX,
  amountStroops: "200000000",
  asset: `USDC:${baseDeployments["usdc_issuer"] as string}`,
  method: "payment",
};

/** Implementación "todo OK" que invoca afterPreflight como haría el servicio real. */
function okWith<T>(value: T) {
  return async (_input: unknown, hooks?: ServiceHooks): Promise<T> => {
    hooks?.afterPreflight?.();
    return value;
  };
}

function fakeService(overrides: Partial<StellarService> = {}): StellarService {
  return {
    registerMerchant: vi.fn(okWith(TX)),
    mintResident: vi.fn(okWith(TX)),
    faucet: vi.fn(okWith(FAUCET_TX)),
    vaultDeposit: vi.fn(okWith(TX)),
    vaultRedeem: vi.fn(okWith(TX)),
    health: vi.fn(async () => ({ protocolVersion: 28, latestLedger: 100, adminUsdcStroops: "3412750000" })),
    queuePending: vi.fn(() => 0),
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];
async function makeApp(service: StellarService = fakeService(), env: Record<string, string> = {}) {
  const { config } = loadConfig(testEnv(env));
  const app = await buildApp({ config, service, logger: createLogger("silent") });
  apps.push(app);
  return { app, config };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const G_ADDR = Keypair.random().publicKey();
const G_ADDR_2 = Keypair.random().publicKey();
const BARRIO = "11".repeat(32);

function post(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "x-raiz-app-key": TEST_KEY, ...headers },
    payload: payload as Record<string, unknown>,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /v1/health", () => {
  it("200 con los contratos del deployments y faucet.enabled cuando hay saldo", async () => {
    const { app, config } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.network).toBe("testnet");
    expect(body.protocolVersion).toBe(28);
    expect(body.admin).toBe(admin.publicKey());
    expect(body.contracts).toEqual({
      pool: baseDeployments["pool"],
      governance: baseDeployments["governance"],
      treasury: baseDeployments["treasury"],
      rewards: baseDeployments["rewards"],
      yield_adapter: baseDeployments["yield_adapter"],
      usdc_sac: baseDeployments["usdc_sac"],
    });
    expect(body.faucet).toEqual({
      enabled: true,
      amountStroops: "200000000",
      adminUsdcStroops: "3412750000",
      remainingToday: config.rates.faucetDaily,
    });
    expect(body.limits).toEqual({
      faucetPerAddressMinutes: 10,
      faucetDaily: 50,
      registerDaily: 20,
      mintDaily: 20,
      vaultDaily: 20,
    });
    expect(body.vaultEndpoints).toBe(true);
    expect(body.queue).toEqual({ pending: 0 });
    expect(body.version).toBe(config.version);
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("faucet.enabled=false cuando el admin tiene menos USDC que el monto", async () => {
    const service = fakeService({
      health: vi.fn(async () => ({ protocolVersion: 28, latestLedger: 1, adminUsdcStroops: "199999999" })),
    });
    const { app } = await makeApp(service);
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json().faucet.enabled).toBe(false);
  });

  it("503 RPC_UNREACHABLE si service.health() lanza, y no se cachea", async () => {
    const health = vi
      .fn<StellarService["health"]>()
      .mockRejectedValueOnce(new RelayerError("RPC_UNREACHABLE", "RPC caído"))
      .mockResolvedValueOnce({ protocolVersion: 28, latestLedger: 1, adminUsdcStroops: "0" });
    const { app } = await makeApp(fakeService({ health }));

    const bad = await app.inject({ method: "GET", url: "/v1/health" });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toEqual({
      ok: false,
      error: { code: "RPC_UNREACHABLE", message: "RPC caído", retryable: true },
    });

    const good = await app.inject({ method: "GET", url: "/v1/health" });
    expect(good.statusCode).toBe(200);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("cachea la lectura del servicio durante healthCacheMs", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { HEALTH_CACHE_MS: "10000" });
    await app.inject({ method: "GET", url: "/v1/health" });
    await app.inject({ method: "GET", url: "/v1/health" });
    expect(service.health).toHaveBeenCalledTimes(1);
  });

  it("503 RPC_UNREACHABLE con envelope si el upstream se cuelga más de HEALTH_UPSTREAM_TIMEOUT_MS", async () => {
    /* Solo se falsean setTimeout/clearTimeout: setImmediate/nextTick los usa
     * light-my-request y con ellos falseados la inyección nunca terminaría. */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let hung = 0;
      const health = vi
        .fn<StellarService["health"]>()
        .mockImplementationOnce(
          () =>
            new Promise(() => {
              hung += 1; // nunca resuelve: simula un RPC que acepta el socket y no contesta
            }),
        )
        .mockResolvedValueOnce({ protocolVersion: 28, latestLedger: 1, adminUsdcStroops: "0" });
      const { app } = await makeApp(fakeService({ health }));

      const pending = app.inject({ method: "GET", url: "/v1/health" });
      await vi.advanceTimersByTimeAsync(HEALTH_UPSTREAM_TIMEOUT_MS);
      const res = await pending;
      expect(hung).toBe(1);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        ok: false,
        error: { code: "RPC_UNREACHABLE", message: "Stellar RPC/Horizon no respondieron a tiempo.", retryable: true },
      });

      /* El timeout no se cachea: la siguiente llamada vuelve al servicio y sale bien. */
      const good = await app.inject({ method: "GET", url: "/v1/health" });
      expect(good.statusCode).toBe(200);
      expect(health).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /v1/live", () => {
  it("200 { ok, uptimeSeconds } sin key y sin llamar a service.health", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await app.inject({ method: "GET", url: "/v1/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, uptimeSeconds: expect.any(Number) });
    expect(service.health).not.toHaveBeenCalled();
  });

  it("sigue respondiendo 200 aunque service.health lance (liveness ≠ health)", async () => {
    const service = fakeService({
      health: vi.fn(async () => {
        throw new RelayerError("RPC_UNREACHABLE", "RPC caído");
      }),
    });
    const { app } = await makeApp(service);
    expect((await app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/v1/live" })).statusCode).toBe(200);
  });
});

describe("limitador por IP", () => {
  const LIMIT = { RATE_PER_IP_PER_MINUTE: "3" };

  it("rotar X-Forwarded-For NO abre cubos nuevos: la 4ª y 5ª request → 429", async () => {
    const { app } = await makeApp(fakeService(), LIMIT);
    const codes: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/health",
        headers: { "x-forwarded-for": `10.0.0.${n}, 1.1.1.1` },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.json()).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });
        expect(res.headers["retry-after"]).toBeDefined();
      }
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it("Fly-Client-IP distinto SÍ separa cubos (es la clave del limitador)", async () => {
    const { app } = await makeApp(fakeService(), LIMIT);
    const hit = (ip: string) => app.inject({ method: "GET", url: "/v1/live", headers: { "fly-client-ip": ip } });
    for (let i = 0; i < 3; i++) expect((await hit("203.0.113.10")).statusCode).toBe(200);
    expect((await hit("203.0.113.10")).statusCode).toBe(429);
    expect((await hit("203.0.113.11")).statusCode).toBe(200);
    /* Sin header: cae al remoteAddress del socket (127.0.0.1 en inject), otro cubo. */
    expect((await app.inject({ method: "GET", url: "/v1/live" })).statusCode).toBe(200);
  });

  it("trustProxy solo confía en loopback/Fly: req.ip no se envenena con X-Forwarded-For", async () => {
    const { app } = await makeApp(fakeService());
    const seen: string[] = [];
    app.addHook("onRequest", async (req) => {
      seen.push(req.ip);
    });
    /* Socket de un cliente directo (no es proxy): XFF se ignora por completo. */
    await app.inject({
      method: "GET",
      url: "/v1/live",
      remoteAddress: "203.0.113.5",
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    /* Socket del proxy (loopback ≈ fdaa: de Fly): req.ip = ÚLTIMA entrada de
     * XFF (la que añade Fly), nunca la primera (que escribe el cliente). */
    await app.inject({
      method: "GET",
      url: "/v1/live",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "10.0.0.1, 198.51.100.7" },
    });
    expect(seen).toEqual(["203.0.113.5", "198.51.100.7"]);
  });

  it("las rutas inexistentes también cuentan: la 4ª petición a un 404 → 429", async () => {
    const { app } = await makeApp(fakeService(), LIMIT);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/no-existe" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND", retryable: false } });
    }
    const res = await app.inject({ method: "GET", url: "/v1/no-existe" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryable: true } });
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("autenticación", () => {
  it("POST sin key → 401 UNAUTHORIZED_APP", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/faucet", payload: { address: G_ADDR } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED_APP");
    expect(res.json().ok).toBe(false);
  });

  it("key incorrecta → 401", async () => {
    const { app } = await makeApp();
    const res = await post(app, "/v1/faucet", { address: G_ADDR }, { "x-raiz-app-key": "otra-key-incorrecta-123" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED_APP");
  });

  it("GET /v1/health no exige key", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("validación y errores nativos de Fastify", () => {
  it("body inválido (address 'hola') → 400 VALIDATION_ERROR", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/faucet", { address: "hola" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("address");
    expect(body.error.details.issues).toContain("address");
    expect(service.faucet).not.toHaveBeenCalled();
  });

  it("JSON malformado → 400 VALIDATION_ERROR", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/faucet",
      headers: { "x-raiz-app-key": TEST_KEY, "content-type": "application/json" },
      payload: "{no es json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("body > 8 KB → 413 PAYLOAD_TOO_LARGE", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/faucet",
      headers: { "x-raiz-app-key": TEST_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ address: "x".repeat(9_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE", retryable: false } });
  });

  it("ruta inexistente → 404 NOT_FOUND con envelope", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/no-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND", retryable: false } });
  });

  it("register-merchant con varios campos malos lista todos los problemas", async () => {
    const { app } = await makeApp();
    const res = await post(app, "/v1/register-merchant", {
      address: G_ADDR,
      name: "a",
      barrioId: "zz",
      latE6: 95_000_000,
      lngE6: 1.5,
      category: "bar",
    });
    expect(res.statusCode).toBe(400);
    const msg: string = res.json().error.message;
    for (const field of ["name", "barrioId", "latE6", "lngE6", "category"]) expect(msg).toContain(field);
  });
});

describe("POST /v1/faucet", () => {
  it("OK → 200 con txHash/amountStroops/asset/method y afterPreflight invocado", async () => {
    let hookSeen = false;
    const faucet = vi.fn(async (_i: unknown, hooks?: ServiceHooks) => {
      hookSeen = typeof hooks?.afterPreflight === "function";
      hooks?.afterPreflight?.();
      return FAUCET_TX;
    });
    const { app } = await makeApp(fakeService({ faucet }));
    const res = await post(app, "/v1/faucet", { address: G_ADDR });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      txHash: FAUCET_TX.txHash,
      ledger: FAUCET_TX.ledger,
      amountStroops: "200000000",
      asset: FAUCET_TX.asset,
      method: "payment",
    });
    expect(hookSeen).toBe(true);
    expect(faucet).toHaveBeenCalledWith({ address: G_ADDR }, expect.objectContaining({ afterPreflight: expect.any(Function) }));
  });

  it("2º faucet a la misma address → 429 RATE_LIMITED con Retry-After y details.retryAfterSeconds", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    expect((await post(app, "/v1/faucet", { address: G_ADDR })).statusCode).toBe(200);

    const res = await post(app, "/v1/faucet", { address: G_ADDR });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryable).toBe(true);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(res.headers["retry-after"]).toBe(String(body.error.details.retryAfterSeconds));
    // El servicio no se llamó la segunda vez (429 temprano)
    expect(service.faucet).toHaveBeenCalledTimes(1);

    // Otra address sigue pudiendo
    expect((await post(app, "/v1/faucet", { address: G_ADDR_2 })).statusCode).toBe(200);
  });

  it("un preflight fallido (NO_TRUSTLINE sin afterPreflight) no consume el cupo", async () => {
    const faucet = vi
      .fn<StellarService["faucet"]>()
      .mockRejectedValueOnce(new RelayerError("NO_TRUSTLINE", "sin trustline"))
      .mockImplementation(okWith(FAUCET_TX));
    const { app } = await makeApp(fakeService({ faucet }));

    const first = await post(app, "/v1/faucet", { address: G_ADDR });
    expect(first.statusCode).toBe(422);
    expect(first.json().error.code).toBe("NO_TRUSTLINE");

    const second = await post(app, "/v1/faucet", { address: G_ADDR });
    expect(second.statusCode).toBe(200);
    expect(faucet).toHaveBeenCalledTimes(2);
  });

  it("el cupo diario global agotado → 429 antes de llamar al servicio", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { RATE_FAUCET_DAILY: "1" });
    expect((await post(app, "/v1/faucet", { address: G_ADDR })).statusCode).toBe(200);
    const res = await post(app, "/v1/faucet", { address: G_ADDR_2 });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(service.faucet).toHaveBeenCalledTimes(1);
  });
});

describe("POST /v1/mint-resident y /v1/register-merchant", () => {
  it("mint OK → 200 { ok, txHash, ledger }", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, txHash: TX.txHash, ledger: TX.ledger });
    expect(service.mintResident).toHaveBeenCalledWith({ address: G_ADDR, barrioId: BARRIO }, expect.anything());
  });

  it("mint cuando el servicio lanza ALREADY_RESIDENT → 409 con envelope", async () => {
    const service = fakeService({
      mintResident: vi.fn(async () => {
        throw new RelayerError("ALREADY_RESIDENT", "Ya es residente.", { contract: "governance", contractCode: 5 });
      }),
    });
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      error: {
        code: "ALREADY_RESIDENT",
        message: "Ya es residente.",
        retryable: false,
        details: { contract: "governance", contractCode: 5 },
      },
    });
  });

  it("register OK → 200 con merchant { address, barrioId }", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const body = { address: G_ADDR, name: "Cafe Don Aurelio", barrioId: BARRIO, latE6: 10421500, lngE6: -75547800, category: "cafe" };
    const res = await post(app, "/v1/register-merchant", body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      txHash: TX.txHash,
      ledger: TX.ledger,
      merchant: { address: G_ADDR, barrioId: BARRIO },
    });
    expect(service.registerMerchant).toHaveBeenCalledWith(body, expect.anything());
  });

  it("register cuando el servicio lanza MERCHANT_EXISTS → 409", async () => {
    const service = fakeService({
      mintResident: vi.fn(okWith(TX)),
      registerMerchant: vi.fn(async () => {
        throw new RelayerError("MERCHANT_EXISTS", "El comercio ya existe.");
      }),
    });
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/register-merchant", {
      address: G_ADDR,
      name: "Cafe Don Aurelio",
      barrioId: BARRIO,
      latE6: 10421500,
      lngE6: -75547800,
      category: "cafe",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MERCHANT_EXISTS");
  });

  it("un error no RelayerError del servicio → 500 INTERNAL genérico", async () => {
    const service = fakeService({
      mintResident: vi.fn(async () => {
        throw new Error("detalle interno que no debe salir");
      }),
    });
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL");
    expect(res.json().error.message).not.toContain("detalle interno");
  });
});

describe("POST /v1/vault/*", () => {
  it("deshabilitado (VAULT_ENDPOINTS_ENABLED=false) → 404", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { VAULT_ENDPOINTS_ENABLED: "false" });
    const res = await post(app, "/v1/vault/deposit", { barrioId: BARRIO, amountStroops: "20000000" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "vault endpoints deshabilitados" } });
    expect(service.vaultDeposit).not.toHaveBeenCalled();

    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.json().vaultEndpoints).toBe(false);
  });

  it("deposit OK → 200 y el servicio recibe amountStroops como bigint", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/vault/deposit", { barrioId: BARRIO, amountStroops: "20000000" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, txHash: TX.txHash, ledger: TX.ledger });
    const [input] = (service.vaultDeposit as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown];
    expect(input).toEqual({ barrioId: BARRIO, amountStroops: 20_000_000n });
    expect(typeof (input as { amountStroops: unknown }).amountStroops).toBe("bigint");
  });

  it("redeem OK → shares como bigint; monto no positivo → 400", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const ok = await post(app, "/v1/vault/redeem", { barrioId: BARRIO, shares: "12345" });
    expect(ok.statusCode).toBe(200);
    expect(service.vaultRedeem).toHaveBeenCalledWith({ barrioId: BARRIO, shares: 12_345n }, expect.anything());

    const bad = await post(app, "/v1/vault/redeem", { barrioId: BARRIO, shares: "0" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("idempotencia", () => {
  it("2 requests con la misma idempotency-key y body → servicio 1 vez y mismas respuestas", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const body = { address: G_ADDR, barrioId: BARRIO };
    const headers = { "idempotency-key": "k-mint-1" };
    const [r1, r2] = await Promise.all([
      post(app, "/v1/mint-resident", body, headers),
      post(app, "/v1/mint-resident", body, headers),
    ]);
    const r3 = await post(app, "/v1/mint-resident", body, headers);
    expect(r1.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(r3.json()).toEqual(r1.json());
    expect(service.mintResident).toHaveBeenCalledTimes(1);
  });

  it("misma key repite un faucet sin chocar con el cupo por address", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const headers = { "idempotency-key": "k-faucet-1" };
    const r1 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);
    const r2 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(service.faucet).toHaveBeenCalledTimes(1);
  });

  it("misma key con body distinto → 422 IDEMPOTENCY_MISMATCH", async () => {
    const { app } = await makeApp();
    const headers = { "idempotency-key": "k-mint-2" };
    await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO }, headers);
    const res = await post(app, "/v1/mint-resident", { address: G_ADDR_2, barrioId: BARRIO }, headers);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("key de más de 64 caracteres → 400", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO }, { "idempotency-key": "x".repeat(65) });
    expect(res.statusCode).toBe(400);
    expect(service.mintResident).not.toHaveBeenCalled();
  });

  it("un error del servicio no se cachea: el reintento con la misma key vuelve a ejecutar", async () => {
    const mintResident = vi
      .fn<StellarService["mintResident"]>()
      .mockRejectedValueOnce(new RelayerError("RPC_UNREACHABLE", "caído"))
      .mockImplementation(okWith(TX));
    const { app } = await makeApp(fakeService({ mintResident }));
    const headers = { "idempotency-key": "k-mint-3" };
    const body = { address: G_ADDR, barrioId: BARRIO };
    expect((await post(app, "/v1/mint-resident", body, headers)).statusCode).toBe(503);
    expect((await post(app, "/v1/mint-resident", body, headers)).statusCode).toBe(200);
    expect(mintResident).toHaveBeenCalledTimes(2);
  });
});
