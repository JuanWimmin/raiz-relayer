/**
 * submitTransaction — LA primitiva única de envío del relayer.
 *
 * Todo lo que firma el admin pasa por aquí (Soroban y clásico), con un solo
 * pipeline y un solo deadline por job (`config.jobDeadlineMs`):
 *
 *   (a) allowlist   → solo contratos de `config.contracts`
 *   (b) getAccount  → secuencia fresca (con reintentos de red)
 *   (c) simulate    → atribución de Error(Contract, #N) al contrato que falló
 *   (d) sign + hash
 *   (e) send        → PENDING/DUPLICATE: poll · TRY_AGAIN_LATER/red: REENVIAR
 *                      EL MISMO ENVELOPE · ERROR: mapear o rebuild
 *   (f) poll        → SUCCESS / FAILED / NOT_FOUND (expirada → rebuild)
 *   (g) rebuild     → como máximo 1 por job, y solo cuando es seguro
 *
 * Anti doble gasto. La regla que gobierna todo el módulo: NUNCA construir un
 * segundo envelope mientras el primero pueda aplicarse todavía. Reenviar el
 * MISMO envelope es siempre seguro (la red lo aplica como mucho una vez); lo
 * peligroso es reconstruir con secuencia nueva sin saber qué pasó con el
 * anterior. Por eso solo reconstruimos cuando (1) el send devolvió ERROR de
 * inmediato (la red nunca aceptó el envelope) o (2) el poll dice NOT_FOUND y el
 * ledger ya cerró más tarde que `maxTime` (ya no puede aplicarse), o (3) el
 * poll dice FAILED (aplicada con fallo: definitivo). Si el deadline vence con
 * un hash en vuelo, devolvemos TX_TIMEOUT con ese hash y NO reconstruimos.
 *
 * Presupuesto de tiempo. El deadline se comprueba ANTES de cada llamada RPC
 * (`ensureBudget`): una llamada solo arranca si quedan más de
 * `config.rpcRequestTimeoutMs` (el timeout HTTP del cliente), así que el job
 * termina como muy tarde en deadline + timeout, siempre por debajo del
 * `jobTimeoutMs` de la cola (config.ts valida la regla). Sin esto, la cola
 * respondería TX_TIMEOUT con txHash null mientras este módulo seguía vivo y
 * podía incluso ENVIAR un envelope nuevo en un rebuild. Un rebuild, además,
 * exige presupuesto para getAccount + simulate + send como mínimo.
 *
 * Nunca se loguea XDR completo ni `sim.error` por encima de nivel debug: el
 * texto del host puede ser largo y no es para el cliente.
 */
import { rpc as sdkRpc, type Account, type Keypair, type Transaction } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import {
  REBUILDABLE_TX_CODES,
  RelayerError,
  mapContractError,
  mapPaymentOpResult,
  parseContractError,
  paymentOpResultName,
  txResultCodeName,
  type SimulationErrorLike,
} from "../errors.js";
import type { Logger } from "../logger.js";
import type { SubmitResult } from "../types.js";

/** Subconjunto de rpc.Server que usamos; en tests se inyecta un falso. */
export interface RpcLike {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<sdkRpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<sdkRpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<sdkRpc.Api.GetTransactionResponse>;
  getLatestLedger(): Promise<sdkRpc.Api.GetLatestLedgerResponse>;
}

export interface SubmitDeps {
  rpc: RpcLike;
  keypair: Keypair;
  config: Config;
  logger: Logger;
  /** Reloj inyectable (ms). */
  now?: () => number;
  /** Sleep inyectable: en tests avanza el reloj falso sin dormir. */
  sleep?: (ms: number) => Promise<void>;
}

export type SubmitSpec =
  | {
      kind: "soroban";
      /** Contrato invocado (debe estar en la allowlist). */
      contractId: string;
      build: (account: Account) => Transaction;
      /** Etiqueta para logs (p. ej. "mint_resident"). */
      label?: string;
    }
  | {
      kind: "classic";
      build: (account: Account) => Transaction;
      label?: string;
    };

/** Intervalo entre consultas getTransaction (un ledger ≈ 5 s). */
const POLL_INTERVAL_MS = 3_000;
/** Máximo de reconstrucciones con secuencia nueva por job. */
const MAX_REBUILDS = 1;
/** Primer `Error(Tipo, Detalle)` del texto de simulación, para details. */
const HOST_ERROR_RE = /Error\((\w+), ([^)]+)\)/;

const GetTxStatus = sdkRpc.Api.GetTransactionStatus;

interface Ctx {
  deps: SubmitDeps;
  spec: SubmitSpec;
  label: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadlineAt: number;
  rebuilds: number;
}

interface Built {
  tx: Transaction;
  /** Hash hex minúsculas del envelope firmado. */
  hash: string;
  /** timeBounds.maxTime (unix s); Infinity si la tx no tiene cota superior. */
  maxTime: number;
}

type Outcome =
  | { kind: "done"; result: SubmitResult }
  /** Hay que reconstruir: `accepted` dice si la red llegó a aceptar el envelope. */
  | { kind: "rebuild"; txResult: string; accepted: boolean };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isAllowlisted(config: Config, contractId: string): boolean {
  return Object.values(config.contracts).includes(contractId);
}

/**
 * Lanza TX_TIMEOUT si no queda presupuesto para UNA llamada RPC completa
 * (remaining <= rpcRequestTimeoutMs). Se invoca justo antes de cada llamada.
 * `txHash` es el envelope en vuelo, si lo hay: el cliente debe comprobarlo
 * antes de reintentar; null significa que nada pudo aplicarse.
 */
function ensureBudget(ctx: Ctx, stage: string, txHash?: string): void {
  const { config, logger } = ctx.deps;
  const remaining = ctx.deadlineAt - ctx.now();
  if (remaining > config.rpcRequestTimeoutMs) return;
  logger.warn(
    { label: ctx.label, stage, txHash: txHash ?? null, remainingMs: remaining, rpcTimeoutMs: config.rpcRequestTimeoutMs },
    "submit: sin presupuesto de tiempo para otra llamada RPC",
  );
  throw new RelayerError(
    "TX_TIMEOUT",
    txHash
      ? "La transacción fue enviada pero no se confirmó dentro del tiempo del relayer. Puede aplicarse todavía: comprueba el hash antes de reintentar."
      : "Se agotó el tiempo del relayer antes de poder enviar la transacción.",
    { txHash: txHash ?? null, stage },
  );
}

/**
 * Convierte una simulación fallida en RelayerError. Exportado porque las
 * lecturas por simulación (reads.ts) mapean igual que el submit.
 */
export function simulationErrorToRelayerError(
  sim: SimulationErrorLike,
  targetContractId: string,
  config: Config,
  logger?: Logger,
  label = "simulate",
): RelayerError {
  const parsed = parseContractError(sim, targetContractId);
  if (parsed) {
    const role = config.rolesByAddress[parsed.contractId] ?? "unknown";
    logger?.info(
      { label, contract: role, contractId: parsed.contractId, contractCode: parsed.code },
      "simulate: error de contrato",
    );
    return mapContractError(role, parsed.code, parsed.contractId);
  }
  // Sin código de contrato: el texto completo del host solo a debug, nunca al cliente.
  logger?.debug({ label, simError: sim.error }, "simulate: fallo sin código de contrato");
  const host = HOST_ERROR_RE.exec(sim.error)?.[0];
  return new RelayerError("TX_FAILED", "La simulación falló", {
    stage: "simulate",
    ...(host ? { hostError: host } : {}),
  });
}

export async function submitTransaction(deps: SubmitDeps, spec: SubmitSpec): Promise<SubmitResult> {
  const { config, logger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const label =
    spec.label ?? (spec.kind === "soroban" ? `soroban:${config.rolesByAddress[spec.contractId] ?? "?"}` : "classic");

  // (a) allowlist: antes de tocar la red.
  if (spec.kind === "soroban" && !isAllowlisted(config, spec.contractId)) {
    logger.error({ label, contractId: spec.contractId }, "submit: contrato fuera de la allowlist");
    throw new RelayerError("INTERNAL", "contrato fuera de la allowlist", { contractId: spec.contractId });
  }

  const startedAt = now();
  const ctx: Ctx = { deps, spec, label, now, sleep, deadlineAt: startedAt + config.jobDeadlineMs, rebuilds: 0 };

  for (;;) {
    const built = await buildAndSign(ctx);
    const outcome = await sendAndPoll(ctx, built);
    if (outcome.kind === "done") {
      logger.info(
        { label, txHash: outcome.result.txHash, ledger: outcome.result.ledger, elapsedMs: now() - startedAt },
        "submit: aplicada",
      );
      return outcome.result;
    }

    // (g) política de rebuild: como máximo una vez por job.
    const priorHash = outcome.accepted ? built.hash : null;
    if (ctx.rebuilds >= MAX_REBUILDS) {
      logger.warn({ label, txHash: priorHash, txResult: outcome.txResult }, "submit: falló de nuevo tras el rebuild");
      throw new RelayerError(
        "TX_FAILED",
        `La transacción volvió a fallar tras reconstruirla (${outcome.txResult}).`,
        { txResult: outcome.txResult, txHash: priorHash, rebuilds: ctx.rebuilds },
      );
    }
    // Un rebuild son como mínimo getAccount + simulate + send (tres llamadas
    // RPC, cada una acotada por rpcRequestTimeoutMs) y un poll. Sin ese
    // presupuesto no se empieza: la tx anterior ya no puede aplicarse (o nunca
    // fue aceptada), así que el cliente puede reintentar sin riesgo.
    const rebuildBudgetMs = 3 * config.rpcRequestTimeoutMs + POLL_INTERVAL_MS;
    if (ctx.deadlineAt - now() < rebuildBudgetMs) {
      logger.warn(
        { label, txResult: outcome.txResult, remainingMs: ctx.deadlineAt - now(), rebuildBudgetMs },
        "submit: sin presupuesto de tiempo para reconstruir",
      );
      throw new RelayerError("TX_TIMEOUT", "Se agotó el tiempo del relayer antes de poder reintentar la transacción.", {
        txHash: null,
        txResult: outcome.txResult,
      });
    }
    ctx.rebuilds += 1;
    logger.info(
      { label, txHash: priorHash, attempt: ctx.rebuilds + 1, txResult: outcome.txResult },
      "submit: reconstruyendo con secuencia fresca",
    );
  }
}

/** Reintenta una llamada RPC idempotente con backoff dentro del deadline. */
async function rpcWithRetry<T>(ctx: Ctx, stage: string, op: () => Promise<T>): Promise<T> {
  const { config, logger } = ctx.deps;
  for (let attempt = 1; ; attempt += 1) {
    // Fuera del try: el TX_TIMEOUT no es un fallo de red que reintentar.
    ensureBudget(ctx, stage);
    try {
      return await op();
    } catch (e) {
      if (e instanceof RelayerError) throw e;
      const remaining = ctx.deadlineAt - ctx.now();
      if (attempt >= config.submitAttempts || remaining <= config.submitBackoffMs) {
        logger.error({ label: ctx.label, stage, attempt, err: errorMessage(e) }, "rpc: inalcanzable");
        throw new RelayerError("RPC_UNREACHABLE", `No se pudo contactar con el RPC de Stellar (${stage}).`, {
          stage,
          attempts: attempt,
        });
      }
      logger.warn({ label: ctx.label, stage, attempt, err: errorMessage(e) }, "rpc: fallo de red, reintentando");
      await ctx.sleep(config.submitBackoffMs);
    }
  }
}

/** (b)(c)(d): cuenta fresca → build → simulate/assemble → sign. */
async function buildAndSign(ctx: Ctx): Promise<Built> {
  const { config, logger, keypair } = ctx.deps;
  const attempt = ctx.rebuilds + 1;

  const account = await rpcWithRetry(ctx, "getAccount", () => ctx.deps.rpc.getAccount(config.adminPublicKey));
  const tx = ctx.spec.build(account);
  logger.info({ label: ctx.label, attempt, sequence: account.sequenceNumber() }, "submit: transacción construida");

  let prepared: Transaction;
  if (ctx.spec.kind === "soroban") {
    const contractId = ctx.spec.contractId;
    const sim = await rpcWithRetry(ctx, "simulateTransaction", () => ctx.deps.rpc.simulateTransaction(tx));
    if (sdkRpc.Api.isSimulationRestore(sim)) {
      logger.warn({ label: ctx.label, contractId }, "simulate: requiere restaurar entradas archivadas");
      throw new RelayerError(
        "RESTORE_REQUIRED",
        "Alguna entrada del ledger que usa esta operación tiene el TTL vencido y debe restaurarse antes (ver runbook).",
        { contractId },
      );
    }
    if (sdkRpc.Api.isSimulationError(sim)) {
      throw simulationErrorToRelayerError(sim, contractId, config, logger, ctx.label);
    }
    prepared = sdkRpc.assembleTransaction(tx, sim).build();
    logger.info({ label: ctx.label, attempt, minResourceFee: sim.minResourceFee }, "simulate: ok");
  } else {
    prepared = tx;
  }

  prepared.sign(keypair);
  const hash = Buffer.from(prepared.hash()).toString("hex");
  const rawMax = Number(prepared.timeBounds?.maxTime);
  const maxTime = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Number.POSITIVE_INFINITY;
  logger.info({ label: ctx.label, txHash: hash, attempt, maxTime }, "submit: firmada");
  return { tx: prepared, hash, maxTime };
}

/** (e)(f): envío (reenviando el mismo envelope) y seguimiento. */
async function sendAndPoll(ctx: Ctx, built: Built): Promise<Outcome> {
  const { config, logger } = ctx.deps;
  const isClassic = ctx.spec.kind === "classic";

  // (e) send loop — mismo envelope en cada intento.
  for (let attempt = 1; ; attempt += 1) {
    // A partir del 2º intento el envelope ya pudo llegar a la red (un fallo de
    // red puede ser de vuelta): el TX_TIMEOUT lleva el hash para que el
    // cliente lo compruebe. En el 1º nada ha salido todavía → null.
    ensureBudget(ctx, "sendTransaction", attempt > 1 ? built.hash : undefined);
    let sent: sdkRpc.Api.SendTransactionResponse;
    try {
      sent = await ctx.deps.rpc.sendTransaction(built.tx);
    } catch (e) {
      if (!(await backoffOrGiveUp(ctx, attempt, "sendTransaction", errorMessage(e), built.hash))) {
        throw new RelayerError("RPC_UNREACHABLE", "No se pudo enviar la transacción al RPC de Stellar.", {
          stage: "sendTransaction",
          attempts: attempt,
          txHash: built.hash,
        });
      }
      continue;
    }
    logger.info({ label: ctx.label, txHash: built.hash, attempt, status: sent.status }, "send");

    if (sent.status === "PENDING" || sent.status === "DUPLICATE") break;

    if (sent.status === "TRY_AGAIN_LATER") {
      if (!(await backoffOrGiveUp(ctx, attempt, "sendTransaction", "TRY_AGAIN_LATER", built.hash))) {
        throw new RelayerError("RPC_UNREACHABLE", "El RPC de Stellar pide reintentar más tarde (TRY_AGAIN_LATER).", {
          stage: "sendTransaction",
          attempts: attempt,
          txHash: built.hash,
        });
      }
      continue;
    }

    // ERROR: la red rechazó el envelope.
    const name = sent.errorResult ? txResultCodeName(sent.errorResult) : "unknown";
    logger.warn({ label: ctx.label, txHash: built.hash, attempt, txResult: name }, "send: ERROR");
    if (REBUILDABLE_TX_CODES.has(name)) {
      // Solo en el PRIMER intento sabemos que la red nunca aceptó el envelope.
      // Si ya hubo un envío anterior (fallo de red / TRY_AGAIN_LATER), un
      // txBadSeq puede significar justo lo contrario: que aquel envío SÍ se
      // aplicó y la secuencia avanzó. Reconstruir aquí sería un doble gasto;
      // pasamos al poll del hash, que decide con SUCCESS/FAILED/expiración.
      if (attempt === 1) return { kind: "rebuild", txResult: name, accepted: false };
      logger.warn(
        { label: ctx.label, txHash: built.hash, attempt, txResult: name },
        "send: ERROR tras un reenvío; verificando el hash antes de decidir",
      );
      break;
    }
    if (isClassic && name === "txFailed" && sent.errorResult) {
      throw mapPaymentOpResult(paymentOpResultName(sent.errorResult) ?? "txFailed", name);
    }
    throw new RelayerError("TX_FAILED", `La red rechazó la transacción (${name}).`, {
      txResult: name,
      stage: "send",
      txHash: built.hash,
    });
  }

  // (f) poll loop.
  for (;;) {
    const remaining = ctx.deadlineAt - ctx.now();
    if (remaining <= 0) {
      logger.warn({ label: ctx.label, txHash: built.hash }, "poll: deadline vencido con la tx en vuelo");
      throw new RelayerError(
        "TX_TIMEOUT",
        "La transacción fue enviada pero no se confirmó dentro del tiempo del relayer. Puede aplicarse todavía: comprueba el hash antes de reintentar.",
        { txHash: built.hash },
      );
    }
    await ctx.sleep(Math.min(POLL_INTERVAL_MS, remaining));

    // Tras dormir puede no quedar presupuesto para la consulta: TX_TIMEOUT con
    // el hash en vuelo, antes de que una llamada colgada rebase el deadline.
    ensureBudget(ctx, "getTransaction", built.hash);
    let got: sdkRpc.Api.GetTransactionResponse;
    try {
      got = await ctx.deps.rpc.getTransaction(built.hash);
    } catch (e) {
      // Un fallo de red durante el poll no es definitivo: seguimos hasta el deadline.
      logger.warn({ label: ctx.label, txHash: built.hash, err: errorMessage(e) }, "poll: fallo de red");
      continue;
    }
    logger.info({ label: ctx.label, txHash: built.hash, status: got.status }, "poll");

    switch (got.status) {
      case GetTxStatus.SUCCESS:
        return { kind: "done", result: { txHash: built.hash, ledger: got.ledger } };

      case GetTxStatus.FAILED: {
        const name = txResultCodeName(got.resultXdr);
        logger.warn({ label: ctx.label, txHash: built.hash, ledger: got.ledger, txResult: name }, "poll: FAILED");
        // Aplicada con fallo: definitivo, así que reconstruir es seguro.
        if (REBUILDABLE_TX_CODES.has(name)) return { kind: "rebuild", txResult: name, accepted: true };
        if (isClassic && name === "txFailed") {
          throw mapPaymentOpResult(paymentOpResultName(got.resultXdr) ?? "txFailed", name);
        }
        throw new RelayerError("TX_FAILED", `La transacción falló on-chain (${name}).`, {
          txResult: name,
          txHash: built.hash,
          ledger: got.ledger,
        });
      }

      case GetTxStatus.NOT_FOUND: {
        const closeTime = await latestCloseTime(ctx, got, built.hash);
        if (closeTime !== undefined && closeTime > built.maxTime) {
          // El último ledger cerró después de maxTime y la tx no está: expiró
          // sin aplicarse (txTooLate) y ya no puede hacerlo.
          logger.warn(
            { label: ctx.label, txHash: built.hash, closeTime, maxTime: built.maxTime },
            "poll: la transacción expiró sin aplicarse",
          );
          return { kind: "rebuild", txResult: "txTooLate", accepted: true };
        }
        continue;
      }
    }
    // Estado fuera del enum (RPC más nuevo que el SDK): seguimos hasta el deadline.
    logger.warn(
      { label: ctx.label, txHash: built.hash, status: (got as { status: string }).status },
      "poll: estado desconocido",
    );
  }
}

/**
 * Decide si toca esperar y reintentar el envío (true) o rendirse (false).
 * `attempt` es el número del intento que acaba de fallar.
 */
async function backoffOrGiveUp(
  ctx: Ctx,
  attempt: number,
  stage: string,
  reason: string,
  txHash: string,
): Promise<boolean> {
  const { config, logger } = ctx.deps;
  const remaining = ctx.deadlineAt - ctx.now();
  if (attempt >= config.submitAttempts || remaining <= config.submitBackoffMs) {
    logger.error({ label: ctx.label, txHash, stage, attempt, reason }, "send: agotados los reintentos");
    return false;
  }
  logger.warn({ label: ctx.label, txHash, stage, attempt, reason }, "send: reintentando el mismo envelope");
  await ctx.sleep(config.submitBackoffMs);
  return true;
}

/**
 * Hora de cierre (unix s) del último ledger conocido: primero la que trae la
 * propia respuesta de getTransaction; si falta, getLatestLedger. `undefined`
 * si no se puede saber (entonces no se declara expirada: solo manda el deadline).
 */
async function latestCloseTime(
  ctx: Ctx,
  got: sdkRpc.Api.GetTransactionResponse,
  txHash: string,
): Promise<number | undefined> {
  const fromTx = Number(got.latestLedgerCloseTime);
  if (Number.isFinite(fromTx) && fromTx > 0) return fromTx;
  // Fuera del try: sin presupuesto es TX_TIMEOUT (con el hash en vuelo), no "no se sabe".
  ensureBudget(ctx, "getLatestLedger", txHash);
  try {
    const latest = await ctx.deps.rpc.getLatestLedger();
    const t = Number(latest.closeTime);
    return Number.isFinite(t) && t > 0 ? t : undefined;
  } catch (e) {
    ctx.deps.logger.warn({ label: ctx.label, err: errorMessage(e) }, "poll: getLatestLedger falló");
    return undefined;
  }
}
