/**
 * POST /v1/register-merchant → Pool.register_merchant(MerchantData)
 *
 * `verified=true` lo fija el servicio (como hoy hace la app). El preflight
 * `get_merchant` del servicio responde 409 MERCHANT_EXISTS si ya existe:
 * el contrato sobrescribiría sin avisar y eso es intervención manual.
 * Cupo: `registerDaily` (20/día global por defecto).
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { parseBody, registerMerchantBody } from "../schemas.js";

export function registerRegisterMerchantRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/register-merchant", { preHandler: [ctx.auth] }, async (req) => {
    const input = parseBody(registerMerchantBody, req.body);
    const result = await ctx.relay(req, {
      scope: "register-merchant",
      limits: [ctx.limits.registerDaily()],
      run: (hooks) => ctx.service.registerMerchant(input, hooks),
    });
    return {
      ok: true,
      txHash: result.txHash,
      ledger: result.ledger,
      merchant: { address: input.address, barrioId: input.barrioId },
    };
  });
}
