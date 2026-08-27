/**
 * POST /v1/mint-resident → Governance.mint_resident(barrio_admin, resident, barrio_id)
 *
 * El relayer firma como `barrio_admin` (el seed pone al admin del protocolo
 * en los 3 barrios). 409 ALREADY_RESIDENT es explícito: la app decide si lo
 * trata como éxito idempotente. Cupo: `mintDaily` (20/día global).
 */
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { mintResidentBody, parseBody } from "../schemas.js";

export function registerMintResidentRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/mint-resident", { preHandler: [ctx.auth] }, async (req) => {
    const input = parseBody(mintResidentBody, req.body);
    const result = await ctx.relay(req, {
      scope: "mint-resident",
      limits: [ctx.limits.mintDaily()],
      run: (hooks) => ctx.service.mintResident(input, hooks),
    });
    return { ok: true, txHash: result.txHash, ledger: result.ledger };
  });
}
