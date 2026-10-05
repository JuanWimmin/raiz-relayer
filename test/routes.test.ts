import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, clientIpKey } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RelayerError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { HEALTH_UPSTREAM_TIMEOUT_MS } from "../src/routes/health.js";
import type { FaucetResult, HealthSnapshot, ServiceHooks, StellarService, SubmitResult } from "../src/types.js";

// ─── Config de test: admin aleatorio + deployments temporal ──────────────────
// `admin` es la CUENTA (deployments.admin); el relayer firma con otra clave
// (`signer`), como tras una rotación. Sin RELAYER_APP_KEY: desde la 0.3.0 no
// hay API key (los tests que la definen o la envían lo hacen a propósito).

/** Valor de la cabecera `x-raiz-app-key` que siguen enviando los APK 0.2.0/0.3.0. */
const LEGACY_KEY = "legacy-app-key-0123456789abcdef";
const admin = Keypair.random();
const signer = Keypair.random();

const baseDeployments = JSON.parse(
  readFileSync(new URL("../config/deployments.testnet.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const tmpDir = mkdtempSync(join(tmpdir(), "raiz-relayer-test-"));
const deploymentsFile = join(tmpDir, "deployments.json");
writeFileSync(deploymentsFile, JSON.stringify({ ...baseDeployments, admin: admin.publicKey() }));

function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NETWORK: "testnet",
    RELAYER_ADMIN_SECRET: signer.secret(),
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

/** Lectura de salud "todo OK" (firmante verificado); cada test cambia lo que le interesa. */
function healthSnap(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { protocolVersion: 28, latestLedger: 100, adminUsdcStroops: "3412750000", signerAuthorized: true, ...overrides };
}

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
    health: vi.fn(async () => healthSnap()),
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

/** POST sin credenciales (así llama cualquier cliente desde la 0.3.0). */
function post(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers,
    payload: payload as Record<string, unknown>,
  });
}

/** Cabecera que escribe fly-proxy con la IP del cliente: la clave de los cupos por IP. */
const fromIp = (ip: string) => ({ "fly-client-ip": ip });
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.11";
const IP_C = "203.0.113.12";
/** Dirección nueva en cada llamada: así el cupo por address del faucet no interviene. */
const freshAddr = () => Keypair.random().publicKey();
const merchantBody = (address: string) => ({
  address,
  name: "Cafe Don Aurelio",
  barrioId: BARRIO,
  latE6: 10421500,
  lngE6: -75547800,
  category: "cafe",
});

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
    // `admin` sigue siendo la CUENTA; `signer` es la clave pública con la que firma el relayer.
    expect(body.admin).toBe(admin.publicKey());
    expect(body.signer).toBe(signer.publicKey());
    expect(body.signer).not.toBe(body.admin);
    expect(body.signerAuthorized).toBe(true);
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
      // Cupos diarios por IP (0.3.0), con sus defaults.
      faucetPerIpDaily: 10,
      registerPerIpDaily: 10,
      mintPerIpDaily: 10,
      vaultPerIpDaily: 20,
    });
    expect(body.vaultEndpoints).toBe(true);
    expect(body.queue).toEqual({ pending: 0 });
    expect(body.version).toBe(config.version);
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("faucet.enabled=false cuando el admin tiene menos USDC que el monto", async () => {
    const service = fakeService({
      health: vi.fn(async () => healthSnap({ adminUsdcStroops: "199999999" })),
    });
    const { app } = await makeApp(service);
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json().faucet.enabled).toBe(false);
  });

  it("signerAuthorized refleja lo que diga el servicio: false (firmante sin autoridad) y null (sin verificar), con el JSON `null` explícito", async () => {
    for (const state of [false, null]) {
      const service = fakeService({ health: vi.fn(async () => healthSnap({ signerAuthorized: state })) });
      const { app } = await makeApp(service);
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.signerAuthorized).toBe(state);
      expect(res.body).toContain(`"signerAuthorized":${String(state)}`);
      // El resto del contrato no cambia: el feature-flag de la app sigue igual.
      expect(body.ok).toBe(true);
      expect(body.admin).toBe(admin.publicKey());
      expect(body.signer).toBe(signer.publicKey());
    }
  });

  it("conserva TODOS los campos que parsea la app (RelayerHealth); `signer` y `signerAuthorized` solo se añaden", async () => {
    const { app } = await makeApp();
    const body = (await app.inject({ method: "GET", url: "/v1/health" })).json();
    expect(Object.keys(body).sort()).toEqual(
      [
        // Los que la app exige (kotlinx.serialization los marca obligatorios)…
        "ok",
        "network",
        "protocolVersion",
        "admin",
        "contracts",
        "faucet",
        "limits",
        "vaultEndpoints",
        "version",
        "uptimeSeconds",
        // …el opcional…
        "queue",
        // …y los nuevos (la app ignora claves desconocidas).
        "signer",
        "signerAuthorized",
      ].sort(),
    );
    // `version` sale del package.json (no hay otra fuente que se pueda desfasar).
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(body.version).toBe(pkg.version);
  });

  it("limits: los cuatro cupos por IP siguen a la configuración y TODO el objeto son enteros (la app lo parsea como Map<String, Int>)", async () => {
    const { app } = await makeApp(fakeService(), {
      FAUCET_PER_IP_DAILY: "30",
      REGISTER_PER_IP_DAILY: "3",
      MINT_PER_IP_DAILY: "4",
      VAULT_PER_IP_DAILY: "5",
    });
    const limits = (await app.inject({ method: "GET", url: "/v1/health" })).json().limits as Record<string, unknown>;
    expect(limits).toMatchObject({ faucetPerIpDaily: 30, registerPerIpDaily: 3, mintPerIpDaily: 4, vaultPerIpDaily: 5 });
    // Aditivo: las claves que ya leía la app siguen ahí, con sus valores.
    expect(limits).toMatchObject({ faucetPerAddressMinutes: 10, faucetDaily: 50, registerDaily: 20, mintDaily: 20, vaultDaily: 20 });
    for (const [key, value] of Object.entries(limits)) expect(Number.isInteger(value), key).toBe(true);
  });

  it("503 RPC_UNREACHABLE si service.health() lanza, y no se cachea", async () => {
    const health = vi
      .fn<StellarService["health"]>()
      .mockRejectedValueOnce(new RelayerError("RPC_UNREACHABLE", "RPC caído"))
      .mockResolvedValueOnce(healthSnap({ latestLedger: 1, adminUsdcStroops: "0" }));
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
        .mockResolvedValueOnce(healthSnap({ latestLedger: 1, adminUsdcStroops: "0" }));
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

describe("sin API key (0.3.0): el relayer es público", () => {
  it("POST sin cabecera x-raiz-app-key → 200 (ya no existe el 401 UNAUTHORIZED_APP)", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const res = await app.inject({ method: "POST", url: "/v1/faucet", payload: { address: G_ADDR } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, txHash: FAUCET_TX.txHash });
    expect(service.faucet).toHaveBeenCalledTimes(1);
  });

  it("los cinco POST responden 200 sin ninguna credencial", async () => {
    const { app } = await makeApp();
    const calls: Array<[string, unknown]> = [
      ["/v1/faucet", { address: G_ADDR }],
      ["/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO }],
      ["/v1/register-merchant", merchantBody(G_ADDR)],
      ["/v1/vault/deposit", { barrioId: BARRIO, amountStroops: "20000000" }],
      ["/v1/vault/redeem", { barrioId: BARRIO, shares: "12345" }],
    ];
    for (const [url, body] of calls) {
      const res = await post(app, url, body);
      expect(res.statusCode, url).toBe(200);
      expect(res.json().ok, url).toBe(true);
    }
  });

  it("la cabecera heredada se ignora, valga lo que valga: los APK 0.2.0/0.3.0 la siguen enviando → 200", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const values = [LEGACY_KEY, "otra-key-cualquiera-123", ""];
    for (const value of values) {
      const res = await post(app, "/v1/faucet", { address: freshAddr() }, { "x-raiz-app-key": value });
      expect(res.statusCode, `x-raiz-app-key: "${value}"`).toBe(200);
      expect(res.json().ok).toBe(true);
    }
    expect(service.faucet).toHaveBeenCalledTimes(values.length);
  });

  it("RELAYER_APP_KEY definida en el entorno no revive la autenticación: sin cabecera o con otra distinta → 200", async () => {
    const service = fakeService();
    const { app, config } = await makeApp(service, { RELAYER_APP_KEY: LEGACY_KEY });
    expect(config).not.toHaveProperty("appKey");
    expect((await post(app, "/v1/mint-resident", { address: G_ADDR, barrioId: BARRIO })).statusCode).toBe(200);
    const other = await post(
      app,
      "/v1/mint-resident",
      { address: G_ADDR_2, barrioId: BARRIO },
      { "x-raiz-app-key": "no-es-la-del-entorno" },
    );
    expect(other.statusCode).toBe(200);
    expect(service.mintResident).toHaveBeenCalledTimes(2);
  });

  it("GET /v1/health sigue sin exigir nada", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("CORS sigue cerrado: sin Access-Control-*, sin preflight, y un POST 'simple' de navegador no llega al servicio", async () => {
    const service = fakeService();
    const { app } = await makeApp(service);
    const origin = { origin: "https://web-de-terceros.example" };

    /* Un POST application/json desde otra web exige preflight: no hay ruta
     * OPTIONS ni cabeceras CORS, así que el navegador nunca envía el POST. */
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/faucet",
      headers: { ...origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.statusCode).toBe(404);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    /* Sin preflight un navegador solo puede mandar estos tipos (o ninguno):
     * el body no se interpreta como JSON y la request muere en la validación.
     * Sin la key, esto es lo que impide que una web reparta peticiones entre
     * las IP de sus visitantes. */
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", undefined]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/faucet",
        headers: { ...origin, ...(contentType ? { "content-type": contentType } : {}) },
        payload: JSON.stringify({ address: G_ADDR }),
      });
      expect(res.statusCode, String(contentType)).toBe(400);
      expect(res.json().error.code, String(contentType)).toBe("VALIDATION_ERROR");
    }
    expect(service.faucet).not.toHaveBeenCalled();

    /* Y una respuesta correcta tampoco lleva cabeceras CORS. */
    const ok = await post(app, "/v1/faucet", { address: G_ADDR }, origin);
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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

describe("cupos diarios por IP (0.3.0)", () => {
  const mintBody = () => ({ address: freshAddr(), barrioId: BARRIO });

  it("faucet: se agota para una IP —429 RATE_LIMITED con Retry-After, sin llamar al servicio— y no para otra", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { FAUCET_PER_IP_DAILY: "2" });
    for (let i = 0; i < 2; i++) {
      expect((await post(app, "/v1/faucet", { address: freshAddr() }, fromIp(IP_A))).statusCode).toBe(200);
    }

    const res = await post(app, "/v1/faucet", { address: freshAddr() }, fromIp(IP_A));
    expect(res.statusCode).toBe(429);
    const { ok, error } = res.json();
    expect(ok).toBe(false);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    // El mensaje dice que es el cupo de ESTA red/IP, no el global.
    expect(error.details.limit).toBe("faucet diario de esta red/IP");
    expect(error.message).toBe(`Cupo agotado (faucet diario de esta red/IP). Reintenta en ${error.details.retryAfterSeconds} s.`);
    // Ventana = día UTC: como mucho faltan 24 h para las 00:00.
    expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    expect(res.headers["retry-after"]).toBe(String(error.details.retryAfterSeconds));
    // 429 temprano: el servicio no se llamó la tercera vez.
    expect(service.faucet).toHaveBeenCalledTimes(2);

    // Otra IP conserva su cupo entero (2), ni más ni menos.
    for (let i = 0; i < 2; i++) {
      expect((await post(app, "/v1/faucet", { address: freshAddr() }, fromIp(IP_B))).statusCode).toBe(200);
    }
    expect((await post(app, "/v1/faucet", { address: freshAddr() }, fromIp(IP_B))).statusCode).toBe(429);
  });

  it("register-merchant, mint-resident y vault tienen cada uno su cupo por IP; deposit y redeem comparten el de vault", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { REGISTER_PER_IP_DAILY: "1", MINT_PER_IP_DAILY: "1", VAULT_PER_IP_DAILY: "2" });
    const a = fromIp(IP_A);
    const deposit = { barrioId: BARRIO, amountStroops: "20000000" };
    const redeem = { barrioId: BARRIO, shares: "12345" };

    expect((await post(app, "/v1/register-merchant", merchantBody(freshAddr()), a)).statusCode).toBe(200);
    const reg = await post(app, "/v1/register-merchant", merchantBody(freshAddr()), a);
    expect(reg.statusCode).toBe(429);
    expect(reg.json().error.details.limit).toBe("registro de comercios diario de esta red/IP");
    expect(reg.headers["retry-after"]).toBeDefined();

    // El cupo de registro agotado no afecta al de mint: son contadores distintos.
    expect((await post(app, "/v1/mint-resident", mintBody(), a)).statusCode).toBe(200);
    const mint = await post(app, "/v1/mint-resident", mintBody(), a);
    expect(mint.statusCode).toBe(429);
    expect(mint.json().error.details.limit).toBe("mint de residentes diario de esta red/IP");
    expect(mint.headers["retry-after"]).toBeDefined();

    // Vault: un deposit y un redeem suman 2 en el MISMO contador.
    expect((await post(app, "/v1/vault/deposit", deposit, a)).statusCode).toBe(200);
    expect((await post(app, "/v1/vault/redeem", redeem, a)).statusCode).toBe(200);
    for (const [url, body] of [
      ["/v1/vault/deposit", deposit],
      ["/v1/vault/redeem", redeem],
    ] as const) {
      const res = await post(app, url, body, a);
      expect(res.statusCode, url).toBe(429);
      expect(res.json().error.details.limit).toBe("operaciones de vault diarias de esta red/IP");
      expect(res.headers["retry-after"]).toBeDefined();
    }

    // Otra IP no nota nada en ninguno de los tres grupos.
    const b = fromIp(IP_B);
    expect((await post(app, "/v1/register-merchant", merchantBody(freshAddr()), b)).statusCode).toBe(200);
    expect((await post(app, "/v1/mint-resident", mintBody(), b)).statusCode).toBe(200);
    expect((await post(app, "/v1/vault/deposit", deposit, b)).statusCode).toBe(200);
    // Los 429 fueron tempranos: el servicio solo vio las requests admitidas.
    expect(service.registerMerchant).toHaveBeenCalledTimes(2);
    expect(service.mintResident).toHaveBeenCalledTimes(2);
    expect(service.vaultDeposit).toHaveBeenCalledTimes(2);
    expect(service.vaultRedeem).toHaveBeenCalledTimes(1);
  });

  it("un preflight fallido (422, 404) o un body inválido (400) no consumen el cupo de la IP", async () => {
    const faucet = vi
      .fn<StellarService["faucet"]>()
      .mockRejectedValueOnce(new RelayerError("NO_TRUSTLINE", "sin trustline"))
      .mockRejectedValueOnce(new RelayerError("ACCOUNT_NOT_FOUND", "no existe"))
      .mockImplementation(okWith(FAUCET_TX));
    const { app } = await makeApp(fakeService({ faucet }), { FAUCET_PER_IP_DAILY: "1" });
    const a = fromIp(IP_A);

    expect((await post(app, "/v1/faucet", { address: freshAddr() }, a)).statusCode).toBe(422);
    expect((await post(app, "/v1/faucet", { address: freshAddr() }, a)).statusCode).toBe(404);
    expect((await post(app, "/v1/faucet", { address: "hola" }, a)).statusCode).toBe(400);
    // El cupo de 1 sigue entero: lo consume la primera que pasa el preflight…
    expect((await post(app, "/v1/faucet", { address: freshAddr() }, a)).statusCode).toBe(200);
    // …y la siguiente ya no cabe.
    const res = await post(app, "/v1/faucet", { address: freshAddr() }, a);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.details.limit).toBe("faucet diario de esta red/IP");
    expect(faucet).toHaveBeenCalledTimes(3);
  });

  it("un submit que sale sí consume, aunque acabe en TX_TIMEOUT (igual que los cupos globales)", async () => {
    const mintResident = vi.fn<StellarService["mintResident"]>().mockImplementation(async (_input, hooks) => {
      hooks?.afterPreflight?.();
      throw new RelayerError("TX_TIMEOUT", "deadline vencido con tx en vuelo", { txHash: "ef".repeat(32) });
    });
    const { app } = await makeApp(fakeService({ mintResident }), { MINT_PER_IP_DAILY: "1" });
    expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(503);
    expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(429);
    expect(mintResident).toHaveBeenCalledTimes(1);
  });

  it("el 429 distingue el cupo de la IP del global; con los dos agotados nombra el global", async () => {
    const { app } = await makeApp(fakeService(), { FAUCET_PER_IP_DAILY: "1", RATE_FAUCET_DAILY: "2" });
    const faucetFrom = (ip: string) => post(app, "/v1/faucet", { address: freshAddr() }, fromIp(ip));
    const limitedFrom = async (ip: string) => {
      const res = await faucetFrom(ip);
      expect(res.statusCode).toBe(429);
      return res.json().error as { message: string; details: { limit: string } };
    };

    expect((await faucetFrom(IP_A)).statusCode).toBe(200);
    // IP_A agotó SU cupo (1); en el global (2) aún queda sitio.
    const perIp = await limitedFrom(IP_A);
    expect(perIp.details.limit).toBe("faucet diario de esta red/IP");
    expect(perIp.message).toContain("de esta red/IP");
    expect(perIp.message).not.toContain("global");

    expect((await faucetFrom(IP_B)).statusCode).toBe(200); // global: 2 de 2
    // IP_C no ha usado nada: lo que la frena es el cupo global.
    const global = await limitedFrom(IP_C);
    expect(global.details.limit).toBe("faucet diario global");
    expect(global.message).toContain("global");
    expect(global.message).not.toContain("red/IP");
    // IP_A tiene agotados los dos: manda el global (cambiar de red ya no serviría).
    expect((await limitedFrom(IP_A)).details.limit).toBe("faucet diario global");
  });

  it("ventana = día UTC: Retry-After cuenta hasta las 00:00 UTC y al cambiar el día la IP recupera su cupo", async () => {
    /* Solo se falsea Date (los timers los necesita light-my-request). La app se
     * crea después para que el limitador lea el reloj falso. */
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 4, 23, 59, 0)); // 2026-10-04T23:59:00Z
      const { app } = await makeApp(fakeService(), { MINT_PER_IP_DAILY: "1" });
      expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(200);

      const blocked = await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A));
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("60");
      expect(blocked.json().error.details).toEqual({
        limit: "mint de residentes diario de esta red/IP",
        retryAfterSeconds: 60,
      });

      vi.setSystemTime(Date.UTC(2026, 9, 5, 0, 0, 0));
      expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sin Fly-Client-IP (local, tests) todas las requests comparten una clave estable: la IP del socket", async () => {
    const { app } = await makeApp(fakeService(), { MINT_PER_IP_DAILY: "1" });
    const mint = (headers: Record<string, string> = {}) => post(app, "/v1/mint-resident", mintBody(), headers);

    expect((await mint()).statusCode).toBe(200);
    // Misma clave (127.0.0.1 en inject), no un cubo nuevo por request…
    expect((await mint()).statusCode).toBe(429);
    // …ni rellenando X-Forwarded-For, que escribe el cliente.
    expect((await mint({ "x-forwarded-for": "198.51.100.77" })).statusCode).toBe(429);
    // Es la MISMA clave que la del limitador por minuto: Fly-Client-IP con esa IP cae en el mismo cubo.
    expect((await mint(fromIp("127.0.0.1"))).statusCode).toBe(429);
    expect((await mint(fromIp(IP_B))).statusCode).toBe(200);
  });

  it("clientIpKey: sin IP resoluble la clave es fija ('unknown'); Fly-Client-IP manda sobre el socket; IPv6 se agrupa por /64", () => {
    const req = (headers: Record<string, string>, remoteAddress?: string) =>
      ({ headers, socket: { remoteAddress } }) as unknown as FastifyRequest;

    expect(clientIpKey(req({}))).toBe("unknown");
    expect(clientIpKey(req({ "fly-client-ip": "   " }))).toBe("unknown");
    expect(clientIpKey(req({}, "10.0.0.1"))).toBe("10.0.0.1");
    expect(clientIpKey(req({ "fly-client-ip": " 203.0.113.10 " }, "10.0.0.1"))).toBe("203.0.113.10");
    // Un cliente IPv6 no tiene 2^64 cubos: dos direcciones del mismo /64 son la misma clave.
    const v6 = (ip: string) => clientIpKey(req({ "fly-client-ip": ip }));
    expect(v6("2001:db8:1:2:aaaa::1")).toBe(v6("2001:db8:1:2:bbbb::2"));
    expect(v6("2001:db8:1:3::1")).not.toBe(v6("2001:db8:1:2::1"));
  });

  it("repetir con la misma idempotency-key no gasta otra unidad del cupo de la IP", async () => {
    const service = fakeService();
    const { app } = await makeApp(service, { MINT_PER_IP_DAILY: "2" });
    const body = { address: G_ADDR, barrioId: BARRIO };
    const headers = { ...fromIp(IP_A), "idempotency-key": "k-ip-1" };
    for (let i = 0; i < 3; i++) expect((await post(app, "/v1/mint-resident", body, headers)).statusCode).toBe(200);
    expect(service.mintResident).toHaveBeenCalledTimes(1);

    // Solo se consumió 1 de 2: cabe una operación nueva, y la siguiente ya no.
    expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(200);
    expect((await post(app, "/v1/mint-resident", mintBody(), fromIp(IP_A))).statusCode).toBe(429);
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

  it("TX_TIMEOUT con txHash SÍ se cachea: 2 POST /v1/faucet con la misma key → servicio 1 vez, ambos 503 con el mismo hash", async () => {
    const IN_FLIGHT_HASH = "ef".repeat(32);
    /* Como el servicio real: el submit ya salió (afterPreflight consumido) y
     * el deadline venció con la tx en vuelo → TX_TIMEOUT con el hash. */
    const faucet = vi.fn<StellarService["faucet"]>().mockImplementation(async (_input, hooks) => {
      hooks?.afterPreflight?.();
      throw new RelayerError("TX_TIMEOUT", "deadline vencido con tx en vuelo", { txHash: IN_FLIGHT_HASH });
    });
    const { app } = await makeApp(fakeService({ faucet }));
    const headers = { "idempotency-key": "k-faucet-timeout" };

    const r1 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);
    const r2 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);

    expect(r1.statusCode).toBe(503);
    expect(r2.statusCode).toBe(503);
    expect(r1.json()).toMatchObject({
      ok: false,
      error: { code: "TX_TIMEOUT", retryable: true, details: { txHash: IN_FLIGHT_HASH } },
    });
    expect(r2.json()).toEqual(r1.json());
    /* No se re-firma: el reintento devuelve el hash en vuelo sin tocar el servicio. */
    expect(faucet).toHaveBeenCalledTimes(1);
  });

  it("TX_TIMEOUT con txHash null (nada salió) NO se cachea: el reintento vuelve al servicio", async () => {
    const faucet = vi
      .fn<StellarService["faucet"]>()
      .mockRejectedValueOnce(new RelayerError("TX_TIMEOUT", "la cola venció antes de enviar", { txHash: null }))
      .mockImplementation(okWith(FAUCET_TX));
    const { app } = await makeApp(fakeService({ faucet }));
    const headers = { "idempotency-key": "k-faucet-timeout-null" };

    const r1 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);
    expect(r1.statusCode).toBe(503);
    expect(r1.json().error).toMatchObject({ code: "TX_TIMEOUT", details: { txHash: null } });

    const r2 = await post(app, "/v1/faucet", { address: G_ADDR }, headers);
    expect(r2.statusCode).toBe(200);
    expect(faucet).toHaveBeenCalledTimes(2);
  });
});
