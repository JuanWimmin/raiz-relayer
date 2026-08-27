/**
 * POST /v1/vault/deposit → Pool.deposit_idle_to_vault(admin, barrio_id, amount)
 * POST /v1/vault/redeem  → Pool.redeem_from_vault(admin, barrio_id, shares)
 *
 * Extensión fuera del SOW (pantalla Yield). Mueven fondos solo Pool ↔
 * yield_adapter, sin pérdida posible. Con `VAULT_ENDPOINTS_ENABLED=false`
 * las rutas existen pero responden 404 NOT_FOUND ("vault endpoints
 * deshabilitados") — sin exigir key, igual que cualquier ruta inexistente.
 *
 * Cupo compartido entre ambas: `vaultDaily` (20/día global). Los montos
 * llegan como string decimal y salen como bigint hacia el servicio.
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { RelayerError } from "../errors.js";
import { parseBody, vaultDepositBody, vaultRedeemBody } from "../schemas.js";

const DEPOSIT_PATH = "/v1/vault/deposit";
const REDEEM_PATH = "/v1/vault/redeem";

export function registerVaultRoutes(app: FastifyInstance, ctx: RouteContext): void {
  if (!ctx.config.vaultEndpointsEnabled) {
    const disabled = async (): Promise<never> => {
      throw new RelayerError("NOT_FOUND", "vault endpoints deshabilitados");
    };
    app.post(DEPOSIT_PATH, disabled);
    app.post(REDEEM_PATH, disabled);
    return;
  }

  app.post(DEPOSIT_PATH, { preHandler: [ctx.auth] }, async (req) => {
    const input = parseBody(vaultDepositBody, req.body);
    const result = await ctx.relay(req, {
      scope: "vault-deposit",
      limits: [ctx.limits.vaultDaily()],
      run: (hooks) => ctx.service.vaultDeposit(input, hooks),
    });
    return { ok: true, txHash: result.txHash, ledger: result.ledger };
  });

  app.post(REDEEM_PATH, { preHandler: [ctx.auth] }, async (req) => {
    const input = parseBody(vaultRedeemBody, req.body);
    const result = await ctx.relay(req, {
      scope: "vault-redeem",
      limits: [ctx.limits.vaultDaily()],
      run: (hooks) => ctx.service.vaultRedeem(input, hooks),
    });
    return { ok: true, txHash: result.txHash, ledger: result.ledger };
  });
}
