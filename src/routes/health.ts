/**
 * GET /v1/health — público (solo bajo el limitador por IP).
 *
 * La app usa `ok` como feature-flag del relayer. La parte cara
 * (`service.health()`: RPC + Horizon) se cachea `healthCacheMs`; los campos
 * baratos (cupo restante, cola, uptime) se calculan en cada llamada. Un fallo
 * del servicio NO se cachea: el siguiente GET vuelve a probar.
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { RelayerError, isRelayerError } from "../errors.js";
import type { HealthSnapshot } from "../types.js";

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
    inflight = service
      .health()
      .then((snap) => {
        cached = { snapshot: snap, expiresAt: Date.now() + config.healthCacheMs };
        return snap;
      })
      .catch((e: unknown) => {
        if (isRelayerError(e)) throw e;
        app.log.error({ err: e }, "health: fallo inesperado del servicio");
        throw new RelayerError("RPC_UNREACHABLE", "No se pudo consultar el RPC/Horizon de testnet.");
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

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
