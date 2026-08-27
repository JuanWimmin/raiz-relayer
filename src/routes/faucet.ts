/**
 * POST /v1/faucet → FAUCET_AMOUNT_STROOPS de USDC (Blend) a la address.
 *
 * G… recibe un `payment` clásico (sigue apareciendo en el historial de la
 * app, que lee Horizon /payments); C… recibe un `transfer` del SAC. Lo decide
 * el servicio y lo devuelve en `method`.
 *
 * Cupos: 1 por address por ventana (`faucetAddress`) + `faucetDaily` global.
 * Se consumen en `afterPreflight`: una G… sin trustline (422) no quema el
 * turno de esa address.
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { faucetBody, parseBody } from "../schemas.js";

export function registerFaucetRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/faucet", { preHandler: [ctx.auth] }, async (req) => {
    const input = parseBody(faucetBody, req.body);
    const result = await ctx.relay(req, {
      scope: "faucet",
      limits: [ctx.limits.faucetAddress(input.address), ctx.limits.faucetDaily()],
      run: (hooks) => ctx.service.faucet(input, hooks),
    });
    return {
      ok: true,
      txHash: result.txHash,
      ledger: result.ledger,
      amountStroops: result.amountStroops,
      asset: result.asset,
      method: result.method,
    };
  });
}
