/**
 * Integración REAL contra Stellar testnet. Solo corre con RELAYER_IT=1 y una
 * configuración válida en el entorno (RELAYER_ADMIN_SECRET del admin vigente,
 * RELAYER_APP_KEY, NETWORK=testnet):
 *
 *   RELAYER_IT=1 RELAYER_ADMIN_SECRET=$(stellar keys show raiz-admin) \
 *   RELAYER_APP_KEY=test-key-0123456789abcdef npx vitest run test/integration
 *
 * Mueve USDC de verdad (de testnet) desde la cuenta admin: 2 faucets de 20 USDC.
 * Escribe los hashes en RELAYER_IT_OUT (o <tmpdir>/raiz-relayer-it.json) para
 * la evidencia del SOW (D1).
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import type { Response as InjectResponse } from "light-my-request";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createStellarService } from "../../src/stellar/service.js";

const IT = process.env.RELAYER_IT === "1";
const describeIt = IT ? describe : describe.skip;

/** Barrio "Centro Histórico" del seed (scripts/seed_testnet.sh). */
const BARRIO_CENTRO = "ce47120000000000000000000000000000000000000000000000000000000001";

interface Evidence {
  ranAt: string;
  network: string;
  admin: string;
  txs: Record<string, { txHash: string; ledger: number; expert: string }>;
  checks: Record<string, string>;
}

describeIt("relayer contra testnet (RELAYER_IT=1)", () => {
  let app: FastifyInstance;
  let config: Config;
  let horizon: Horizon.Server;
  const appKey = process.env.RELAYER_APP_KEY ?? "";
  const evidence: Evidence = { ranAt: new Date().toISOString(), network: "testnet", admin: "", txs: {}, checks: {} };

  // Cuentas de prueba frescas (no se persisten: cada run usa unas nuevas).
  const residentKp = Keypair.random(); // G… que recibe faucet + soulbound
  const merchantKp = Keypair.random(); // G… que se registra como comercio (no necesita fondos)
  const smartAccount = StrKey.encodeContract(randomBytes(32)); // C… destino del SAC transfer

  const post = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<InjectResponse> =>
    app.inject({ method: "POST", url, payload: body as Record<string, unknown>, headers: { "x-raiz-app-key": appKey, ...headers } });

  const expert = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
  const record = (name: string, body: { txHash: string; ledger: number }) => {
    evidence.txs[name] = { txHash: body.txHash, ledger: body.ledger, expert: expert(body.txHash) };
  };

  beforeAll(async () => {
    const loaded = loadConfig(process.env);
    config = loaded.config;
    evidence.admin = config.adminPublicKey;
    const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
    const service = createStellarService({ config, adminKeypair: loaded.adminKeypair, logger });
    app = await buildApp({ config, service, logger });
    horizon = new Horizon.Server(config.horizonUrl);

    // friendbot para el residente (XLM de reserva para la trustline)
    const fb = await fetch(`https://friendbot.stellar.org/?addr=${residentKp.publicKey()}`);
    if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    const out = process.env.RELAYER_IT_OUT ?? join(tmpdir(), "raiz-relayer-it.json");
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n[IT] evidencia escrita en ${out}\n${JSON.stringify(evidence, null, 2)}`);
  });

  it("GET /v1/health responde 200 con los contratos del deploy vigente", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.network).toBe("testnet");
    expect(body.contracts.pool).toBe(config.contracts.pool);
    expect(body.contracts.usdc_sac).toBe(config.contracts.usdc_sac);
    expect(body.faucet.enabled).toBe(true);
    evidence.checks.health = `protocolVersion=${body.protocolVersion} adminUsdcStroops=${body.faucet.adminUsdcStroops}`;
  });

  it("faucet a una G… inexistente → 404 ACCOUNT_NOT_FOUND", async () => {
    const res = await post("/v1/faucet", { address: Keypair.random().publicKey() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    evidence.checks.accountNotFound = "404 ACCOUNT_NOT_FOUND";
  });

  it("faucet a una G… sin trustline → 422 NO_TRUSTLINE", async () => {
    const res = await post("/v1/faucet", { address: residentKp.publicKey() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NO_TRUSTLINE");
    evidence.checks.noTrustline = "422 NO_TRUSTLINE";
  });

  it("con trustline: faucet a G… → 200 (payment clásico) y el balance sube 20 USDC", async () => {
    // Trustline firmada por el propio residente (como hace la app antes del faucet).
    const source = await horizon.loadAccount(residentKp.publicKey());
    const usdc = new Asset("USDC", config.usdcIssuer);
    const tx = new TransactionBuilder(source, { fee: "1000", networkPassphrase: config.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    tx.sign(residentKp);
    await horizon.submitTransaction(tx);

    const res = await post("/v1/faucet", { address: residentKp.publicKey() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.method).toBe("payment");
    expect(body.amountStroops).toBe(config.faucetAmountStroops.toString());
    expect(body.txHash).toMatch(/^[0-9a-f]{64}$/);
    record("faucet_G_payment", body);

    const after = await horizon.loadAccount(residentKp.publicKey());
    const line = after.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === config.usdcIssuer);
    expect(line?.balance).toBe("20.0000000");
  }, 180_000);

  it("faucet repetido a la misma G… en <10 min → 429 RATE_LIMITED con Retry-After", async () => {
    const res = await post("/v1/faucet", { address: residentKp.publicKey() });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBeDefined();
    evidence.checks.rateLimited = `429 retry-after=${String(res.headers["retry-after"])}`;
  });

  it("faucet a un C… → 200 (SAC transfer)", async () => {
    const res = await post("/v1/faucet", { address: smartAccount });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.method).toBe("sac_transfer");
    record("faucet_C_sac_transfer", body);
  }, 180_000);

  it("mint-resident → 200; repetido → 409 ALREADY_RESIDENT", async () => {
    const res = await post("/v1/mint-resident", { address: residentKp.publicKey(), barrioId: BARRIO_CENTRO });
    expect(res.statusCode, res.body).toBe(200);
    record("mint_resident", res.json());

    const again = await post("/v1/mint-resident", { address: residentKp.publicKey(), barrioId: BARRIO_CENTRO });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_RESIDENT");
    evidence.checks.alreadyResident = "409 ALREADY_RESIDENT";
  }, 180_000);

  it("register-merchant → 200; repetido → 409 MERCHANT_EXISTS", async () => {
    const body = {
      address: merchantKp.publicKey(),
      name: "Cafe IT Relayer",
      barrioId: BARRIO_CENTRO,
      latE6: 10_421_500,
      lngE6: -75_547_800,
      category: "cafe",
    };
    const res = await post("/v1/register-merchant", body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().merchant.address).toBe(merchantKp.publicKey());
    record("register_merchant", res.json());

    const again = await post("/v1/register-merchant", body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("MERCHANT_EXISTS");
    evidence.checks.merchantExists = "409 MERCHANT_EXISTS";
  }, 180_000);

  it("mint-resident con barrio inexistente → 404 BARRIO_ADMIN_NOT_SET", async () => {
    const res = await post("/v1/mint-resident", { address: Keypair.random().publicKey(), barrioId: "ff".repeat(32) });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("BARRIO_ADMIN_NOT_SET");
    evidence.checks.barrioAdminNotSet = "404 BARRIO_ADMIN_NOT_SET";
  }, 120_000);
});
