import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc as sdkRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { RelayerError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { submitTransaction, type RpcLike, type SubmitDeps, type SubmitSpec } from "../src/stellar/submit.js";

const logger = createLogger("silent");
const GetTxStatus = sdkRpc.Api.GetTransactionStatus;

// ── Config real desde un deployments.json temporal con admin = Keypair.random() ─

const admin = Keypair.random();
let config: Config;
let adminKeypair: Keypair;
let tmpDeployments: string;

beforeAll(() => {
  const base = JSON.parse(
    readFileSync(new URL("../config/deployments.testnet.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  tmpDeployments = join(tmpdir(), `raiz-relayer-deployments-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmpDeployments, JSON.stringify({ ...base, admin: admin.publicKey() }));
  ({ config, adminKeypair } = loadConfig({
    NETWORK: "testnet",
    RELAYER_ADMIN_SECRET: admin.secret(),
    RELAYER_APP_KEY: "x".repeat(32),
    DEPLOYMENTS_FILE: tmpDeployments,
  }));
});

afterAll(() => {
  rmSync(tmpDeployments, { force: true });
});

// ── Reloj falso: sleep avanza el tiempo sin dormir ───────────────────────────

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

// ── Respuestas RPC falsas (tipos del SDK 17) ─────────────────────────────────

type SendRes = sdkRpc.Api.SendTransactionResponse;
type GetRes = sdkRpc.Api.GetTransactionResponse;

const sendPending = (): SendRes => ({ status: "PENDING", hash: "", latestLedger: 100, latestLedgerCloseTime: 1 });
const sendDuplicate = (): SendRes => ({ status: "DUPLICATE", hash: "", latestLedger: 100, latestLedgerCloseTime: 1 });
const sendTryAgain = (): SendRes => ({ status: "TRY_AGAIN_LATER", hash: "", latestLedger: 100, latestLedgerCloseTime: 1 });
const sendError = (errorResult: xdr.TransactionResult): SendRes => ({
  status: "ERROR",
  hash: "",
  latestLedger: 100,
  latestLedgerCloseTime: 1,
  errorResult,
});

/** closeTime = 1 (1970): nunca supera el maxTime de una tx construida hoy. */
const getNotFound = (latestLedgerCloseTime = 1): GetRes => ({
  status: GetTxStatus.NOT_FOUND,
  txHash: "",
  latestLedger: 100,
  latestLedgerCloseTime,
  oldestLedger: 1,
  oldestLedgerCloseTime: 0,
});
const getSuccess = (ledger = 4_365_434): GetRes =>
  ({ status: GetTxStatus.SUCCESS, txHash: "", ledger, latestLedger: ledger, latestLedgerCloseTime: 1 }) as unknown as GetRes;
const getFailed = (resultXdr: xdr.TransactionResult, ledger = 4_365_435): GetRes =>
  ({ status: GetTxStatus.FAILED, txHash: "", ledger, latestLedger: ledger, latestLedgerCloseTime: 1, resultXdr }) as unknown as GetRes;

const txResult = (r: xdr.TransactionResultResult): xdr.TransactionResult =>
  new xdr.TransactionResult({ feeCharged: 100n, result: r, ext: xdr.TransactionResultExt.v0() });

const simOk = (): sdkRpc.Api.SimulateTransactionResponse =>
  ({
    _parsed: true,
    id: "1",
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  }) as sdkRpc.Api.SimulateTransactionSuccessResponse;

const simError = (error: string): sdkRpc.Api.SimulateTransactionResponse =>
  ({ _parsed: true, id: "1", latestLedger: 100, events: [], error }) as sdkRpc.Api.SimulateTransactionErrorResponse;

/**
 * RPC falso con guiones: `sendQueue` y `getQueue` se consumen en orden (un
 * Error en la cola se lanza como fallo de red); agotada la de get se repite
 * `getDefault` (NOT_FOUND) para simular una tx que no aparece nunca.
 */
class FakeRpc implements RpcLike {
  getAccountCalls = 0;
  simulated: Transaction[] = [];
  sentXdrs: string[] = [];
  getCalls = 0;
  sendQueue: Array<SendRes | Error> = [];
  getQueue: Array<GetRes | Error> = [];
  getDefault: GetRes = getNotFound();
  sim: sdkRpc.Api.SimulateTransactionResponse = simOk();

  async getAccount(address: string): Promise<Account> {
    this.getAccountCalls += 1;
    // Secuencia distinta en cada llamada: un rebuild produce otro envelope.
    return new Account(address, String(1_000 + this.getAccountCalls));
  }
  async simulateTransaction(tx: Transaction): Promise<sdkRpc.Api.SimulateTransactionResponse> {
    this.simulated.push(tx);
    return this.sim;
  }
  async sendTransaction(tx: Transaction): Promise<SendRes> {
    this.sentXdrs.push(tx.toXDR());
    const next = this.sendQueue.shift();
    if (next === undefined) throw new Error("FakeRpc: sendQueue vacía");
    if (next instanceof Error) throw next;
    return next;
  }
  async getTransaction(_hash: string): Promise<GetRes> {
    this.getCalls += 1;
    const next = this.getQueue.shift() ?? this.getDefault;
    if (next instanceof Error) throw next;
    return next;
  }
  async getLatestLedger(): Promise<sdkRpc.Api.GetLatestLedgerResponse> {
    return { id: "x", sequence: 100, protocolVersion: "28", closeTime: "1" } as unknown as sdkRpc.Api.GetLatestLedgerResponse;
  }
}

function deps(rpc: FakeRpc, clock = fakeClock()): SubmitDeps {
  return { rpc, keypair: adminKeypair, config, logger, now: clock.now, sleep: clock.sleep };
}

function sorobanSpec(contractId: string, method = "mint_resident"): SubmitSpec {
  return {
    kind: "soroban",
    contractId,
    label: method,
    build: (account) =>
      new TransactionBuilder(account, { fee: "500000", networkPassphrase: Networks.TESTNET })
        .addOperation(
          new Contract(contractId).call(
            method,
            Address.fromString(admin.publicKey()).toScVal(),
            Address.fromString(Keypair.random().publicKey()).toScVal(),
            xdr.ScVal.scvBytes(new Uint8Array(32)),
          ),
        )
        .setTimeout(30)
        .build(),
  };
}

function classicSpec(destination = Keypair.random().publicKey()): SubmitSpec {
  return {
    kind: "classic",
    label: "faucet_payment",
    build: (account) =>
      new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET })
        .addOperation(
          Operation.payment({ destination, asset: new Asset("USDC", config.usdcIssuer), amount: "20.0000000" }),
        )
        .setTimeout(30)
        .build(),
  };
}

function hashOfXdr(envelope: string): string {
  return Buffer.from(new Transaction(envelope, Networks.TESTNET).hash()).toString("hex");
}

async function relayerError(p: Promise<unknown>): Promise<RelayerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RelayerError) return e;
    throw new Error(`se esperaba RelayerError, llegó ${String(e)}`);
  }
  throw new Error("se esperaba un rechazo");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("submitTransaction", () => {
  it("(1) camino feliz soroban: simulate ok → PENDING → NOT_FOUND ×2 → SUCCESS", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [getNotFound(), getNotFound(), getSuccess(4_365_434)];
    const clock = fakeClock();

    const result = await submitTransaction(deps(rpc, clock), sorobanSpec(config.contracts.governance));

    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ledger).toBe(4_365_434);
    expect(rpc.getAccountCalls).toBe(1);
    expect(rpc.simulated).toHaveLength(1);
    const simulatedTx = rpc.simulated[0];
    expect(simulatedTx).toBeInstanceOf(Transaction);
    expect(simulatedTx?.operations).toHaveLength(1);
    expect(simulatedTx?.operations[0]?.type).toBe("invokeHostFunction");
    expect(rpc.sentXdrs).toHaveLength(1);
    expect(hashOfXdr(rpc.sentXdrs[0] ?? "")).toBe(result.txHash);
    expect(rpc.getCalls).toBe(3);
    // Tres esperas de poll de 3 s, ninguna de backoff.
    expect(clock.sleeps).toEqual([3_000, 3_000, 3_000]);
  });

  it("(2) simulación con Error(Contract, #5) contra Governance → ALREADY_RESIDENT sin enviar nada", async () => {
    const rpc = new FakeRpc();
    rpc.sim = simError("HostError: Error(Contract, #5)\n\nEvent log (newest first):\n");

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance)));
    expect(e.code).toBe("ALREADY_RESIDENT");
    expect(e.http).toBe(409);
    expect(e.details).toMatchObject({ contract: "governance", contractCode: 5, name: "AlreadyResident" });
    expect(rpc.sentXdrs).toHaveLength(0);
    expect(rpc.getCalls).toBe(0);
  });

  it("(3) el MISMO #5 contra yield_adapter → CONTRACT_ERROR InsufficientShares (atribución por contrato)", async () => {
    const rpc = new FakeRpc();
    rpc.sim = simError("HostError: Error(Contract, #5)\n\nEvent log (newest first):\n");

    const e = await relayerError(
      submitTransaction(deps(rpc), sorobanSpec(config.contracts.yield_adapter, "withdraw")),
    );
    expect(e.code).toBe("CONTRACT_ERROR");
    expect(e.http).toBe(422);
    expect(e.details).toMatchObject({
      contract: "yield_adapter",
      contractCode: 5,
      name: "InsufficientShares",
      contractId: config.contracts.yield_adapter,
    });
    expect(rpc.sentXdrs).toHaveLength(0);
  });

  it("(3b) simulación fallida sin código de contrato → TX_FAILED stage simulate, sin el texto crudo", async () => {
    const rpc = new FakeRpc();
    rpc.sim = simError("HostError: Error(Auth, InvalidAction)\n\nun log larguísimo que no debe salir");

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.pool)));
    expect(e.code).toBe("TX_FAILED");
    expect(e.details).toMatchObject({ stage: "simulate", hostError: "Error(Auth, InvalidAction)" });
    expect(JSON.stringify(e.toBody())).not.toContain("larguísimo");
  });

  it("(3c) simulación con restorePreamble → RESTORE_REQUIRED", async () => {
    const rpc = new FakeRpc();
    rpc.sim = {
      ...(simOk() as sdkRpc.Api.SimulateTransactionSuccessResponse),
      restorePreamble: { minResourceFee: "1", transactionData: new SorobanDataBuilder() },
    } as sdkRpc.Api.SimulateTransactionRestoreResponse;

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.pool)));
    expect(e.code).toBe("RESTORE_REQUIRED");
    expect(e.retryable).toBe(true);
    expect(rpc.sentXdrs).toHaveLength(0);
  });

  it("(4) TRY_AGAIN_LATER ×2 y luego PENDING → se reenvía EL MISMO envelope y tiene éxito", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendTryAgain(), sendTryAgain(), sendPending()];
    rpc.getQueue = [getSuccess()];
    const clock = fakeClock();

    const result = await submitTransaction(deps(rpc, clock), sorobanSpec(config.contracts.governance));

    expect(rpc.sentXdrs).toHaveLength(3);
    expect(new Set(rpc.sentXdrs).size).toBe(1);
    expect(rpc.getAccountCalls).toBe(1);
    expect(rpc.simulated).toHaveLength(1);
    expect(hashOfXdr(rpc.sentXdrs[0] ?? "")).toBe(result.txHash);
    // Dos backoffs (submitBackoffMs) + un poll.
    expect(clock.sleeps).toEqual([config.submitBackoffMs, config.submitBackoffMs, 3_000]);
  });

  it("(4b) excepción de red en el send también reenvía el mismo envelope", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [new Error("ECONNRESET"), sendDuplicate()];
    rpc.getQueue = [getSuccess()];

    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));
    expect(rpc.sentXdrs).toHaveLength(2);
    expect(rpc.sentXdrs[0]).toBe(rpc.sentXdrs[1]);
    expect(result.ledger).toBe(4_365_434);
  });

  it("(4c) TRY_AGAIN_LATER permanente → RPC_UNREACHABLE tras submitAttempts, sin rebuild", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = Array.from({ length: config.submitAttempts + 2 }, () => sendTryAgain());

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance)));
    expect(e.code).toBe("RPC_UNREACHABLE");
    expect(e.retryable).toBe(true);
    expect(rpc.sentXdrs).toHaveLength(config.submitAttempts);
    expect(new Set(rpc.sentXdrs).size).toBe(1);
    expect(rpc.getAccountCalls).toBe(1);
  });

  it("(5) send ERROR txBadSeq sin hash aceptado → rebuild una vez (getAccount ×2) → éxito", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendError(txResult(xdr.TransactionResultResult.txBadSeq())), sendPending()];
    rpc.getQueue = [getSuccess(4_365_440)];

    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));

    expect(result.ledger).toBe(4_365_440);
    expect(rpc.getAccountCalls).toBe(2);
    expect(rpc.simulated).toHaveLength(2);
    expect(rpc.sentXdrs).toHaveLength(2);
    // Envelope distinto (secuencia nueva) y el hash devuelto es el del segundo.
    expect(rpc.sentXdrs[0]).not.toBe(rpc.sentXdrs[1]);
    expect(hashOfXdr(rpc.sentXdrs[1] ?? "")).toBe(result.txHash);
  });

  it("(5b) un segundo txBadSeq tras el rebuild → TX_FAILED con txResult (máx. 1 rebuild)", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [
      sendError(txResult(xdr.TransactionResultResult.txBadSeq())),
      sendError(txResult(xdr.TransactionResultResult.txBadSeq())),
    ];

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance)));
    expect(e.code).toBe("TX_FAILED");
    expect(e.details).toMatchObject({ txResult: "txBadSeq", rebuilds: 1 });
    expect(rpc.getAccountCalls).toBe(2);
    expect(rpc.sentXdrs).toHaveLength(2);
  });

  it("(5c) NOT_FOUND con el ledger cerrado después de maxTime → expiró: rebuild y éxito", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending(), sendPending()];
    // maxTime = now + 30 s; un closeTime muy posterior significa que ya no puede aplicarse.
    const farFuture = Math.floor(Date.now() / 1000) + 3_600;
    rpc.getQueue = [getNotFound(1), getNotFound(farFuture), getSuccess(4_365_450)];

    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));

    expect(result.ledger).toBe(4_365_450);
    expect(rpc.getAccountCalls).toBe(2);
    expect(rpc.sentXdrs).toHaveLength(2);
    expect(rpc.sentXdrs[0]).not.toBe(rpc.sentXdrs[1]);
    expect(hashOfXdr(rpc.sentXdrs[1] ?? "")).toBe(result.txHash);
  });

  it("(6) NOT_FOUND hasta pasar el deadline → TX_TIMEOUT con details.txHash del envelope en vuelo", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getDefault = getNotFound(1);
    const clock = fakeClock();

    const e = await relayerError(submitTransaction(deps(rpc, clock), sorobanSpec(config.contracts.governance)));

    expect(e.code).toBe("TX_TIMEOUT");
    expect(e.http).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.details?.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.details?.txHash).toBe(hashOfXdr(rpc.sentXdrs[0] ?? ""));
    // Sin rebuild: la tx sigue en vuelo y reconstruir sería doble gasto.
    expect(rpc.getAccountCalls).toBe(1);
    expect(rpc.sentXdrs).toHaveLength(1);
    // El tiempo dormido nunca supera el deadline.
    const slept = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThanOrEqual(config.jobDeadlineMs);
    expect(slept).toBeGreaterThanOrEqual(config.jobDeadlineMs - 3_000);
  });

  it("(6b) fallo de red en el poll no es definitivo: sigue consultando", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [new Error("timeout"), new Error("timeout"), getSuccess()];

    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));
    expect(result.ledger).toBe(4_365_434);
    expect(rpc.getCalls).toBe(3);
  });

  it("(7) clásico: FAILED con paymentNoTrust → NO_TRUSTLINE, sin simulación", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [
      getFailed(
        txResult(
          xdr.TransactionResultResult.txFailed([
            xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentNoTrust())),
          ]),
        ),
      ),
    ];

    const e = await relayerError(submitTransaction(deps(rpc), classicSpec()));
    expect(e.code).toBe("NO_TRUSTLINE");
    expect(e.http).toBe(422);
    expect(e.details).toMatchObject({ opResult: "paymentNoTrust", txResult: "txFailed" });
    expect(rpc.simulated).toHaveLength(0);
    expect(rpc.sentXdrs).toHaveLength(1);
    expect(new Transaction(rpc.sentXdrs[0] ?? "", Networks.TESTNET).operations[0]?.type).toBe("payment");
  });

  it("(7b) clásico: send ERROR txFailed con paymentUnderfunded → FAUCET_EMPTY", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [
      sendError(
        txResult(
          xdr.TransactionResultResult.txFailed([
            xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded())),
          ]),
        ),
      ),
    ];

    const e = await relayerError(submitTransaction(deps(rpc), classicSpec()));
    expect(e.code).toBe("FAUCET_EMPTY");
    expect(rpc.getCalls).toBe(0);
  });

  it("(7c) soroban: FAILED on-chain con txFailed → TX_FAILED con txResult y txHash", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [getFailed(txResult(xdr.TransactionResultResult.txFailed([])))];

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(config.contracts.pool)));
    expect(e.code).toBe("TX_FAILED");
    expect(e.http).toBe(502);
    expect(e.details).toMatchObject({ txResult: "txFailed", txHash: hashOfXdr(rpc.sentXdrs[0] ?? "") });
  });

  it("(8) allowlist: contractId desconocido → INTERNAL sin tocar el RPC", async () => {
    const rpc = new FakeRpc();
    const unknownContract = StrKey.encodeContract(new Uint8Array(32).fill(7));

    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(unknownContract)));
    expect(e.code).toBe("INTERNAL");
    expect(e.message).toContain("allowlist");
    expect(rpc.getAccountCalls).toBe(0);
    expect(rpc.simulated).toHaveLength(0);
    expect(rpc.sentXdrs).toHaveLength(0);
  });

  it("(8b) blend_pool está en rolesByAddress pero NO en la allowlist de invocación", async () => {
    const rpc = new FakeRpc();
    const blend = config.deployments.blend_pool;
    expect(blend).toBeDefined();
    const e = await relayerError(submitTransaction(deps(rpc), sorobanSpec(blend ?? "")));
    expect(e.code).toBe("INTERNAL");
    expect(rpc.getAccountCalls).toBe(0);
  });

  it("(9) getAccount con fallos de red transitorios se reintenta; permanente → RPC_UNREACHABLE", async () => {
    class FlakyRpc extends FakeRpc {
      failures = 0;
      override async getAccount(address: string): Promise<Account> {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error("fetch failed");
        }
        return super.getAccount(address);
      }
    }
    const ok = new FlakyRpc();
    ok.failures = 2;
    ok.sendQueue = [sendPending()];
    ok.getQueue = [getSuccess()];
    await expect(submitTransaction(deps(ok), sorobanSpec(config.contracts.pool))).resolves.toMatchObject({
      ledger: 4_365_434,
    });

    const dead = new FlakyRpc();
    dead.failures = 100;
    const e = await relayerError(submitTransaction(deps(dead), sorobanSpec(config.contracts.pool)));
    expect(e.code).toBe("RPC_UNREACHABLE");
    expect(e.details).toMatchObject({ stage: "getAccount" });
    expect(dead.sentXdrs).toHaveLength(0);
  });
});

// ── Anti doble gasto: ERROR rebuildable tras un reenvío ──────────────────────

describe("submitTransaction — txBadSeq tras un reenvío no reconstruye", () => {
  it("(9) red falla en el 1er send, el reenvío responde ERROR txBadSeq → poll del hash → SUCCESS, sin rebuild", async () => {
    // Escenario real: el 1er envío SÍ llegó a la red (el timeout fue de vuelta),
    // se aplicó y consumió la secuencia; el reenvío del mismo envelope recibe
    // txBadSeq. Reconstruir aquí = segundo faucet. Debe hacer poll y encontrar SUCCESS.
    const rpc = new FakeRpc();
    rpc.sendQueue = [new Error("socket hang up"), sendError(txResult(xdr.TransactionResultResult.txBadSeq()))];
    rpc.getQueue = [getSuccess(4_365_440)];
    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));

    expect(result.ledger).toBe(4_365_440);
    expect(rpc.getAccountCalls).toBe(1); // ni un rebuild
    expect(rpc.sentXdrs).toHaveLength(2);
    expect(rpc.sentXdrs[0]).toBe(rpc.sentXdrs[1]); // mismo envelope reenviado
    expect(result.txHash).toBe(hashOfXdr(rpc.sentXdrs[0]!));
  });

  it("(10) ERROR txBadSeq en el PRIMER send sí reconstruye (la red nunca aceptó el envelope)", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendError(txResult(xdr.TransactionResultResult.txBadSeq())), sendPending()];
    rpc.getQueue = [getSuccess(4_365_441)];
    const result = await submitTransaction(deps(rpc), sorobanSpec(config.contracts.governance));

    expect(result.ledger).toBe(4_365_441);
    expect(rpc.getAccountCalls).toBe(2); // exactamente un rebuild
    expect(rpc.sentXdrs[0]).not.toBe(rpc.sentXdrs[1]);
  });
});
