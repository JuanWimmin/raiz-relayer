/**
 * GET /v1/live y GET /v1/health — públicos (solo bajo el limitador por IP).
 *
 * `/v1/live` = "el proceso está vivo": no toca la red, siempre 200. Es lo que
 * sondean el check de Fly y el HEALTHCHECK de Docker; si apuntaran a
 * `/v1/health` (503 cuando cae Stellar) el proxy sacaría al relayer justo
 * cuando la app necesita leer `ok:false` para apagar el flujo admin.
 *
 * `/v1/health` = feature-flag de la app (`ok` + `faucet.enabled` +
 * `vaultEndpoints`) con estado real de Stellar. La parte cara
 * (`service.health()`: RPC + Horizon) se cachea `healthCacheMs`; los campos
 * baratos (cupo restante, cola, uptime) se calculan en cada llamada. Un fallo
 * del servicio NO se cachea: el siguiente GET vuelve a probar. La ida al
 * upstream tiene un tope de `HEALTH_UPSTREAM_TIMEOUT_MS` para que el 503 con
 * envelope salga aunque RPC/Horizon se cuelguen sin cerrar el socket.
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { RelayerError, isRelayerError } from "../errors.js";
import type { HealthSnapshot } from "../types.js";

/**
 * Tope de espera a RPC/Horizon en /v1/health. Debe quedar por debajo del
 * `timeout`/`interval` de cualquier sondeo externo y del timeout HTTP de la
 * app: si el upstream se cuelga, preferimos un 503 rápido y honesto a un
 * socket abierto indefinidamente (que además bloquearía `app.close()`).
 */
export const HEALTH_UPSTREAM_TIMEOUT_MS = 8_000;

/** Promise.race con temporizador; el timer se limpia siempre (sin fugas). */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function registerHealthRoute(app: FastifyInstance, ctx: RouteContext): void {
  const { config, service, limits } = ctx;
  let cached: { snapshot: HealthSnapshot; expiresAt: number } | undefined;
  let inflight: Promise<HealthSnapshot> | undefined;

  const contracts = {
    pool: config.contracts.pool,
    governance: config.contracts.governance,
    treasury: config.contracts.treasury,
    rewards: config.contracts.rewards,
    yield_adapter: config.contracts.yield_adapter,
    usdc_sac: config.contracts.usdc_sac,
  };

  async function snapshot(): Promise<HealthSnapshot> {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.snapshot;
    /* Varias llamadas simultáneas sin cache comparten una sola ida al RPC. */
    if (inflight) return inflight;
    inflight = withTimeout(
      service.health(),
      HEALTH_UPSTREAM_TIMEOUT_MS,
      () => new RelayerError("RPC_UNREACHABLE", "Stellar RPC/Horizon no respondieron a tiempo."),
    )
      .then((snap) => {
        cached = { snapshot: snap, expiresAt: Date.now() + config.healthCacheMs };
        return snap;
      })
      .catch((e: unknown) => {
        /* Ni el timeout ni ningún otro error se cachean: el siguiente GET reintenta. */
        if (isRelayerError(e)) throw e;
        app.log.error({ err: e }, "health: fallo inesperado del servicio");
        throw new RelayerError("RPC_UNREACHABLE", "No se pudo consultar el RPC/Horizon de testnet.");
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  /* Liveness: sin red, sin auth, sin caché. Solo el limitador por IP. */
  app.get("/v1/live", async () => ({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  app.get("/v1/health", async () => {
    const snap = await snapshot();
    const adminUsdc = BigInt(snap.adminUsdcStroops);
    return {
      ok: true,
      network: config.network,
      protocolVersion: snap.protocolVersion,
      admin: config.adminPublicKey,
      contracts,
      faucet: {
        enabled: adminUsdc >= config.faucetAmountStroops,
        amountStroops: config.faucetAmountStroops.toString(),
        adminUsdcStroops: snap.adminUsdcStroops,
        remainingToday: limits.faucetDaily().snapshot().remaining,
      },
      limits: {
        faucetPerAddressMinutes: Math.round(config.rates.faucetPerAddressWindowMs / 60_000),
        faucetDaily: config.rates.faucetDaily,
        registerDaily: config.rates.registerDaily,
        mintDaily: config.rates.mintDaily,
        vaultDaily: config.rates.vaultDaily,
      },
      vaultEndpoints: config.vaultEndpointsEnabled,
      queue: { pending: service.queuePending() },
      version: config.version,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });
}
