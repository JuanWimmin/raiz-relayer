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
  NotFoundError,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc as sdkRpc,
  xdr,
  type Horizon,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { RelayerError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { SerialQueue } from "../src/queue.js";
import type { ContractRpcLike, HorizonLike } from "../src/stellar/reads.js";
import { createStellarService } from "../src/stellar/service.js";
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
    /** Latencia simulada de una llamada RPC (no cuenta como sleep). */
    advance: (ms: number) => {
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
 * `latencyMs` + `tick`: cada llamada "tarda" avanzando el reloj falso, para
 * probar el presupuesto de tiempo (ensureBudget) sin dormir.
 */
class FakeRpc implements RpcLike, ContractRpcLike {
  getAccountCalls = 0;
  simulated: Transaction[] = [];
  sentXdrs: string[] = [];
  getCalls = 0;
  sendQueue: Array<SendRes | Error> = [];
  getQueue: Array<GetRes | Error> = [];
  getDefault: GetRes = getNotFound();
  sim: sdkRpc.Api.SimulateTransactionResponse = simOk();
  /** Latencia simulada por llamada (ms), aplicada vía `tick` ANTES de responder. */
  latencyMs = 0;
  tick: (ms: number) => void = () => undefined;
  /** getContractInstance: "exists" resuelve; "missing" rechaza como el SDK 17; un Error simula red caída. */
  contractInstance: "exists" | "missing" | Error = "exists";
  contractInstanceCalls: string[] = [];

  async getAccount(address: string): Promise<Account> {
    this.tick(this.latencyMs);
    this.getAccountCalls += 1;
    // Secuencia distinta en cada llamada: un rebuild produce otro envelope.
    return new Account(address, String(1_000 + this.getAccountCalls));
  }
  async simulateTransaction(tx: Transaction): Promise<sdkRpc.Api.SimulateTransactionResponse> {
    this.tick(this.latencyMs);
    this.simulated.push(tx);
    return this.sim;
  }
  async sendTransaction(tx: Transaction): Promise<SendRes> {
    this.tick(this.latencyMs);
    this.sentXdrs.push(tx.toXDR());
    const next = this.sendQueue.shift();
    if (next === undefined) throw new Error("FakeRpc: sendQueue vacía");
    if (next instanceof Error) throw next;
    return next;
  }
  async getTransaction(_hash: string): Promise<GetRes> {
    this.tick(this.latencyMs);
    this.getCalls += 1;
    const next = this.getQueue.shift() ?? this.getDefault;
    if (next instanceof Error) throw next;
    return next;
  }
  async getLatestLedger(): Promise<sdkRpc.Api.GetLatestLedgerResponse> {
    this.tick(this.latencyMs);
    return { id: "x", sequence: 100, protocolVersion: "28", closeTime: "1" } as unknown as sdkRpc.Api.GetLatestLedgerResponse;
  }
  async getContractInstance(contractId: string): Promise<unknown> {
    this.tick(this.latencyMs);
    this.contractInstanceCalls.push(contractId);
    if (this.contractInstance instanceof Error) throw this.contractInstance;
    if (this.contractInstance === "missing") {
      // Exactamente lo que rechaza rpc.Server.getContractInstance (objeto plano, no Error).
      return Promise.reject({ code: 404, message: "Could not obtain contract instance from server" });
    }
    return { executable: { type: "contractExecutableWasm" } };
  }
}

/** Horizon falso: mapa de cuentas → balances; cuenta ausente → NotFoundError como el SDK. */
class FakeHorizon implements HorizonLike {
  accounts = new Map<string, Horizon.HorizonApi.BalanceLine[]>();
  calls: string[] = [];
  failWith: Error | undefined;

  async loadAccount(accountId: string): Promise<{ balances: Horizon.HorizonApi.BalanceLine[] }> {
    this.calls.push(accountId);
    if (this.failWith) throw this.failWith;
    const balances = this.accounts.get(accountId);
    if (!balances) throw new NotFoundError("Not Found", { status: 404 });
    return { balances };
  }
}

function usdcLine(balance: string, authorized = true): Horizon.HorizonApi.BalanceLine {
  return {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: config.usdcIssuer,
    balance,
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    last_modified_ledger: 1,
    is_authorized: authorized,
    is_authorized_to_maintain_liabilities: authorized,
    is_clawback_enabled: false,
  } as unknown as Horizon.HorizonApi.BalanceLine;
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

describe("loadConfig — presupuesto de tiempo", () => {
  const baseEnv = () => ({
    NETWORK: "testnet",
    RELAYER_ADMIN_SECRET: admin.secret(),
    RELAYER_APP_KEY: "x".repeat(32),
    DEPLOYMENTS_FILE: tmpDeployments,
  });

  it("defaults: deadline 70 s, timeout HTTP 15 s, cola 90 s (= 70 + 15 + 5)", () => {
    expect(config.jobDeadlineMs).toBe(70_000);
    expect(config.rpcRequestTimeoutMs).toBe(15_000);
    expect(config.jobTimeoutMs).toBe(90_000);
  });

  it("rechaza JOB_TIMEOUT_MS < JOB_DEADLINE_MS + RPC_REQUEST_TIMEOUT_MS + 5000 con un mensaje que explica la regla", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), JOB_DEADLINE_MS: "70000", RPC_REQUEST_TIMEOUT_MS: "15000", JOB_TIMEOUT_MS: "89999" }),
    ).toThrow(/JOB_TIMEOUT_MS \(89999\) debe ser >= JOB_DEADLINE_MS \+ RPC_REQUEST_TIMEOUT_MS \+ 5000.*= 90000/);
    // Justo en el límite pasa; y RPC_REQUEST_TIMEOUT_MS < 1000 no se admite.
    expect(() =>
      loadConfig({ ...baseEnv(), JOB_DEADLINE_MS: "20000", RPC_REQUEST_TIMEOUT_MS: "5000", JOB_TIMEOUT_MS: "30000" }),
    ).not.toThrow();
    expect(() => loadConfig({ ...baseEnv(), RPC_REQUEST_TIMEOUT_MS: "999" })).toThrow(/RPC_REQUEST_TIMEOUT_MS/);
  });
});

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
    // Se corta ANTES de la primera consulta para la que no queda presupuesto
    // (remaining <= rpcRequestTimeoutMs), así que lo dormido queda entre
    // deadline - timeout - un poll y el deadline.
    expect(e.details?.stage).toBe("getTransaction");
    const slept = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThanOrEqual(config.jobDeadlineMs);
    expect(slept).toBeGreaterThanOrEqual(config.jobDeadlineMs - config.rpcRequestTimeoutMs - 3_000);
  });

  it("(6c) cada llamada RPC tarda el timeout HTTP y la tx no aparece → TX_TIMEOUT con txHash sin rebasar el deadline", async () => {
    // Peor caso real: cada petición agota rpcRequestTimeoutMs. Antes del fix
    // el poll consultaba con remaining ≈ 0 y el job acababa en deadline +
    // timeout, con la cola respondiendo TX_TIMEOUT (txHash null) mientras.
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getDefault = getNotFound(1);
    const clock = fakeClock();
    rpc.latencyMs = config.rpcRequestTimeoutMs;
    rpc.tick = clock.advance;
    const start = clock.now();

    const e = await relayerError(submitTransaction(deps(rpc, clock), sorobanSpec(config.contracts.governance)));

    expect(e.code).toBe("TX_TIMEOUT");
    expect(e.details?.txHash).toBe(hashOfXdr(rpc.sentXdrs[0] ?? ""));
    expect(e.details?.stage).toBe("getTransaction");
    expect(rpc.getCalls).toBeGreaterThan(0);
    expect(rpc.getAccountCalls).toBe(1);
    expect(rpc.sentXdrs).toHaveLength(1);
    const elapsed = clock.now() - start;
    // Contrato con la cola: nunca más de deadline + una llamada colgada…
    expect(elapsed).toBeLessThanOrEqual(config.jobDeadlineMs + config.rpcRequestTimeoutMs);
    // …y como ninguna llamada arranca sin presupuesto, ni siquiera el deadline.
    expect(elapsed).toBeLessThanOrEqual(config.jobDeadlineMs);
  });

  it("(6d) rebuild necesario sin presupuesto para getAccount+simulate+send → TX_TIMEOUT sin segunda getAccount", async () => {
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendError(txResult(xdr.TransactionResultResult.txBadSeq())), sendPending()];
    rpc.getQueue = [getSuccess()];
    const clock = fakeClock();
    // Tres llamadas de 12 s: al recibir el ERROR quedan 34 s, menos que los
    // 3 × 15 s + 3 s (poll) que exige un rebuild.
    rpc.latencyMs = 12_000;
    rpc.tick = clock.advance;

    const e = await relayerError(submitTransaction(deps(rpc, clock), sorobanSpec(config.contracts.governance)));

    expect(e.code).toBe("TX_TIMEOUT");
    expect(e.details).toMatchObject({ txHash: null, txResult: "txBadSeq" });
    expect(rpc.getAccountCalls).toBe(1);
    expect(rpc.simulated).toHaveLength(1);
    expect(rpc.sentXdrs).toHaveLength(1);
  });

  it("(6e) sin presupuesto antes de la primera llamada → TX_TIMEOUT stage getAccount con txHash null y sin tocar la red", async () => {
    const rpc = new FakeRpc();
    const clock = fakeClock();
    // La primera lectura del reloj fija startedAt; a partir de ahí el tiempo
    // ya ha saltado el deadline entero (p. ej. el job esperó en la cola).
    let reads = 0;
    const jumpedNow = () => (reads++ === 0 ? clock.now() : clock.now() + config.jobDeadlineMs);
    const slowDeps: SubmitDeps = { ...deps(rpc, clock), now: jumpedNow };

    const e = await relayerError(submitTransaction(slowDeps, sorobanSpec(config.contracts.governance)));
    expect(e.code).toBe("TX_TIMEOUT");
    expect(e.details).toEqual({ txHash: null, stage: "getAccount" });
    expect(rpc.getAccountCalls).toBe(0);
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

// ── createStellarService: preflights y orden cupo → cola ─────────────────────

describe("createStellarService — preflights del faucet y orden assertCapacity → afterPreflight → enqueue", () => {
  function makeService(rpc: FakeRpc, horizon: FakeHorizon, queue?: SerialQueue) {
    return createStellarService({
      config,
      adminKeypair,
      logger,
      clients: { rpc: rpc as unknown as sdkRpc.Server, horizon: horizon as unknown as Horizon.Server },
      ...(queue ? { queue } : {}),
    });
  }

  /** Horizon con el admin fondeado (100 USDC) y `dest` con trustline autorizada. */
  function fundedHorizon(dest?: string): FakeHorizon {
    const horizon = new FakeHorizon();
    horizon.accounts.set(admin.publicKey(), [usdcLine("100.0000000")]);
    if (dest) horizon.accounts.set(dest, [usdcLine("0.0000000")]);
    return horizon;
  }

  it("(11) con la cola al cap, faucet rechaza QUEUE_FULL SIN invocar afterPreflight (el cupo no se quema)", async () => {
    const queue = new SerialQueue({ cap: 1, jobTimeoutMs: config.jobTimeoutMs, logger });
    let release!: () => void;
    const blocker = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      "bloqueo",
    );
    const dest = Keypair.random().publicKey();
    const rpc = new FakeRpc();
    const service = makeService(rpc, fundedHorizon(dest), queue);
    const afterPreflight = vi.fn();

    const e = await relayerError(service.faucet({ address: dest }, { afterPreflight }));
    expect(e.code).toBe("QUEUE_FULL");
    expect(e.http).toBe(503);
    expect(afterPreflight).not.toHaveBeenCalled();
    expect(queue.pending()).toBe(1);
    expect(rpc.getAccountCalls).toBe(0);

    release();
    await blocker;
    await queue.drain(); // el contador baja un microtask después de resolver el job
    expect(queue.pending()).toBe(0);
  });

  it("(11b) con sitio: afterPreflight se invoca una vez, tras los preflights y antes del submit; si lanza, no se encola nada", async () => {
    const dest = Keypair.random().publicKey();
    const rpc = new FakeRpc();
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [getSuccess(4_365_460)];
    const queue = new SerialQueue({ cap: 5, jobTimeoutMs: config.jobTimeoutMs, logger });
    const service = makeService(rpc, fundedHorizon(dest), queue);
    const seen: number[] = [];
    const afterPreflight = vi.fn(() => {
      seen.push(rpc.getAccountCalls); // 0: todavía no ha arrancado el submit
    });

    const result = await service.faucet({ address: dest }, { afterPreflight });
    expect(result.method).toBe("payment");
    expect(result.ledger).toBe(4_365_460);
    expect(afterPreflight).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([0]);

    // Hook que lanza (RATE_LIMITED): aborta sin encolar ni tocar el RPC.
    const rpc2 = new FakeRpc();
    const queue2 = new SerialQueue({ cap: 5, jobTimeoutMs: config.jobTimeoutMs, logger });
    const service2 = makeService(rpc2, fundedHorizon(dest), queue2);
    const e = await relayerError(
      service2.faucet(
        { address: dest },
        {
          afterPreflight: () => {
            throw new RelayerError("RATE_LIMITED", "cupo");
          },
        },
      ),
    );
    expect(e.code).toBe("RATE_LIMITED");
    expect(queue2.pending()).toBe(0);
    expect(rpc2.getAccountCalls).toBe(0);
  });

  it("(12) faucet a un C… no desplegado → 404 ACCOUNT_NOT_FOUND antes de mirar Horizon, sin cupo ni submit", async () => {
    const missing = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const rpc = new FakeRpc();
    rpc.contractInstance = "missing";
    const horizon = fundedHorizon();
    const service = makeService(rpc, horizon);
    const afterPreflight = vi.fn();

    const e = await relayerError(service.faucet({ address: missing }, { afterPreflight }));
    expect(e.code).toBe("ACCOUNT_NOT_FOUND");
    expect(e.http).toBe(404);
    expect(e.message).toContain("smart account");
    expect(e.details).toEqual({ address: missing });
    expect(rpc.contractInstanceCalls).toEqual([missing]);
    expect(horizon.calls).toHaveLength(0);
    expect(afterPreflight).not.toHaveBeenCalled();
    expect(rpc.sentXdrs).toHaveLength(0);
  });

  it("(12b) faucet a un C… desplegado → pasa el preflight y envía el transfer del SAC (method sac_transfer)", async () => {
    const deployed = StrKey.encodeContract(new Uint8Array(32).fill(3));
    const rpc = new FakeRpc();
    rpc.contractInstance = "exists";
    rpc.sendQueue = [sendPending()];
    rpc.getQueue = [getSuccess(4_365_470)];
    const service = makeService(rpc, fundedHorizon());
    const afterPreflight = vi.fn();

    const result = await service.faucet({ address: deployed }, { afterPreflight });
    expect(result.method).toBe("sac_transfer");
    expect(result.ledger).toBe(4_365_470);
    expect(afterPreflight).toHaveBeenCalledTimes(1);
    expect(rpc.contractInstanceCalls).toEqual([deployed]);
    const tx = new Transaction(rpc.sentXdrs[0] ?? "", Networks.TESTNET);
    expect(tx.operations[0]?.type).toBe("invokeHostFunction");
  });

  it("(12c) RPC caído en getContractInstance → RPC_UNREACHABLE con solo { stage } (sin texto crudo de red)", async () => {
    const rpc = new FakeRpc();
    rpc.contractInstance = new Error("ECONNREFUSED 10.0.0.7:443 detalle-interno");
    const service = makeService(rpc, fundedHorizon());

    const e = await relayerError(service.faucet({ address: StrKey.encodeContract(new Uint8Array(32).fill(5)) }));
    expect(e.code).toBe("RPC_UNREACHABLE");
    expect(e.details).toEqual({ stage: "getContractInstance" });
    expect(JSON.stringify(e.toBody())).not.toContain("detalle-interno");
  });

  it("(12d) Horizon caído en el preflight de una G… → RPC_UNREACHABLE con solo { stage }", async () => {
    const horizon = new FakeHorizon();
    horizon.failWith = new Error("socket hang up host-interno");
    const service = makeService(new FakeRpc(), horizon);

    const e = await relayerError(service.faucet({ address: Keypair.random().publicKey() }));
    expect(e.code).toBe("RPC_UNREACHABLE");
    expect(e.details).toEqual({ stage: "horizon.loadAccount" });
    expect(JSON.stringify(e.toBody())).not.toContain("host-interno");
  });

  it("(13) register-merchant: get_merchant con restorePreamble = el comercio existe (archivado) → MERCHANT_EXISTS, no RESTORE_REQUIRED", async () => {
    const rpc = new FakeRpc();
    rpc.sim = {
      ...(simOk() as sdkRpc.Api.SimulateTransactionSuccessResponse),
      restorePreamble: { minResourceFee: "1", transactionData: new SorobanDataBuilder() },
    } as sdkRpc.Api.SimulateTransactionRestoreResponse;
    const service = makeService(rpc, fundedHorizon());
    const afterPreflight = vi.fn();

    const e = await relayerError(
      service.registerMerchant(
        {
          address: Keypair.random().publicKey(),
          name: "Cafe Archivado",
          barrioId: "ce".repeat(32),
          latE6: 10_421_500,
          lngE6: -75_547_800,
          category: "cafe",
        },
        { afterPreflight },
      ),
    );
    expect(e.code).toBe("MERCHANT_EXISTS");
    expect(e.http).toBe(409);
    expect(afterPreflight).not.toHaveBeenCalled();
    expect(rpc.simulated).toHaveLength(1); // solo la lectura get_merchant
    expect(rpc.sentXdrs).toHaveLength(0);
  });
});
