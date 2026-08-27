/**
 * Modelo de errores del relayer.
 *
 * Toda respuesta de error tiene la forma
 *   { ok: false, error: { code, message, retryable, details? } }
 * y el HTTP status se deriva del `code` (tabla HTTP_BY_CODE).
 *
 * Los errores de contrato (`Error(Contract, #N)`) se atribuyen al contrato que
 * falló usando los eventos de diagnóstico de la simulación: los códigos de
 * Pool, Governance, yield_adapter y el SAC de USDC colisionan entre sí
 * (p. ej. #5 es AlreadyResident en Governance pero InsufficientShares en el
 * adapter), así que nunca se mapea un número sin saber de qué contrato viene.
 *
 * XDR: este repo usa @stellar/stellar-sdk 17 (XDR basado en clases: campos
 * como propiedades readonly, uniones con discriminante `.type`). Ver
 * docs/SDK17_XDR.md.
 */
import { StrKey, scValToNative, type xdr } from "@stellar/stellar-sdk";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED_APP"
  | "NOT_FOUND"
  | "BARRIO_NOT_FOUND"
  | "BARRIO_ADMIN_NOT_SET"
  | "ACCOUNT_NOT_FOUND"
  | "ALREADY_RESIDENT"
  | "MERCHANT_EXISTS"
  | "PAYLOAD_TOO_LARGE"
  | "NO_TRUSTLINE"
  | "TRUSTLINE_DEAUTHORIZED"
  | "IDEMPOTENCY_MISMATCH"
  | "CONTRACT_ERROR"
  | "RATE_LIMITED"
  | "UNAUTHORIZED_ADMIN"
  | "TX_FAILED"
  | "FAUCET_EMPTY"
  | "RPC_UNREACHABLE"
  | "QUEUE_FULL"
  | "RESTORE_REQUIRED"
  | "TX_TIMEOUT"
  | "INTERNAL";

export const HTTP_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED_APP: 401,
  NOT_FOUND: 404,
  BARRIO_NOT_FOUND: 404,
  BARRIO_ADMIN_NOT_SET: 404,
  ACCOUNT_NOT_FOUND: 404,
  ALREADY_RESIDENT: 409,
  MERCHANT_EXISTS: 409,
  PAYLOAD_TOO_LARGE: 413,
  NO_TRUSTLINE: 422,
  TRUSTLINE_DEAUTHORIZED: 422,
  IDEMPOTENCY_MISMATCH: 422,
  CONTRACT_ERROR: 422,
  RATE_LIMITED: 429,
  UNAUTHORIZED_ADMIN: 502,
  TX_FAILED: 502,
  FAUCET_EMPTY: 503,
  RPC_UNREACHABLE: 503,
  QUEUE_FULL: 503,
  RESTORE_REQUIRED: 503,
  TX_TIMEOUT: 503,
  INTERNAL: 500,
};

/** Códigos que el cliente puede reintentar tal cual (misma request). */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "RPC_UNREACHABLE",
  "QUEUE_FULL",
  "TX_TIMEOUT",
  "RESTORE_REQUIRED",
]);

export type ErrorDetails = Record<string, string | number | boolean | null>;

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean; details?: ErrorDetails };
}

export class RelayerError extends Error {
  readonly code: ErrorCode;
  readonly http: number;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "RelayerError";
    this.code = code;
    this.http = HTTP_BY_CODE[code];
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isRelayerError(e: unknown): e is RelayerError {
  return e instanceof RelayerError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contratos conocidos y sus tablas de errores (espejo de contracts/*/src/lib.rs)
// ─────────────────────────────────────────────────────────────────────────────

/** Rol de cada contrato que el relayer conoce (por address). */
export type ContractRole =
  | "pool"
  | "governance"
  | "treasury"
  | "rewards"
  | "yield_adapter"
  | "usdc_sac"
  | "blend_pool";

interface ContractErrorSpec {
  name: string;
  code: ErrorCode;
  message: string;
}

/** contracts/pool/src/lib.rs — enum Error */
const POOL_ERRORS: Record<number, ContractErrorSpec> = {
  1: { name: "NotInitialized", code: "CONTRACT_ERROR", message: "El contrato Pool no está inicializado." },
  2: { name: "AlreadyInitialized", code: "CONTRACT_ERROR", message: "El contrato Pool ya estaba inicializado." },
  3: { name: "Unauthorized", code: "UNAUTHORIZED_ADMIN", message: "La cuenta del relayer no es el admin del Pool (relayer mal configurado)." },
  4: { name: "MerchantNotFound", code: "NOT_FOUND", message: "El comercio no existe." },
  5: { name: "MerchantNotVerified", code: "CONTRACT_ERROR", message: "El comercio no está verificado." },
  6: { name: "BarrioNotFound", code: "BARRIO_NOT_FOUND", message: "El barrio no existe en el Pool." },
  7: { name: "InvalidAmount", code: "CONTRACT_ERROR", message: "Monto inválido." },
  8: { name: "InvalidTipBps", code: "CONTRACT_ERROR", message: "tip_bps inválido." },
  9: { name: "AdapterNotConfigured", code: "CONTRACT_ERROR", message: "El Pool no tiene yield_adapter configurado." },
  10: { name: "InsufficientLiquidity", code: "CONTRACT_ERROR", message: "El depósito violaría el colchón líquido del barrio." },
  11: { name: "AdapterHasPositions", code: "CONTRACT_ERROR", message: "El adapter aún tiene posiciones." },
  12: { name: "InvalidBps", code: "CONTRACT_ERROR", message: "Basis points inválidos." },
};

/** contracts/governance/src/lib.rs — enum Error */
const GOVERNANCE_ERRORS: Record<number, ContractErrorSpec> = {
  1: { name: "NotInitialized", code: "CONTRACT_ERROR", message: "El contrato Governance no está inicializado." },
  2: { name: "AlreadyInitialized", code: "CONTRACT_ERROR", message: "Governance ya estaba inicializado." },
  3: { name: "Unauthorized", code: "UNAUTHORIZED_ADMIN", message: "La cuenta del relayer no es el admin de este barrio (relayer mal configurado)." },
  4: { name: "BarrioAdminNotSet", code: "BARRIO_ADMIN_NOT_SET", message: "El barrio no tiene admin configurado on-chain." },
  5: { name: "AlreadyResident", code: "ALREADY_RESIDENT", message: "Esta dirección ya tiene su soulbound de residente." },
  6: { name: "NotAResident", code: "CONTRACT_ERROR", message: "No es residente." },
  7: { name: "ProposalNotFound", code: "NOT_FOUND", message: "Propuesta no encontrada." },
  8: { name: "InvalidDuration", code: "CONTRACT_ERROR", message: "Duración inválida." },
  9: { name: "InvalidAmount", code: "CONTRACT_ERROR", message: "Monto inválido." },
  10: { name: "AlreadyVoted", code: "CONTRACT_ERROR", message: "Ya votó." },
  11: { name: "ProposalClosed", code: "CONTRACT_ERROR", message: "Propuesta cerrada." },
  12: { name: "ProposalNotActive", code: "CONTRACT_ERROR", message: "Propuesta no activa." },
};

/** contracts/yield_adapter/src/lib.rs — enum Error (¡colisiona con Pool/Governance!) */
const ADAPTER_ERRORS: Record<number, ContractErrorSpec> = {
  1: { name: "NotInitialized", code: "CONTRACT_ERROR", message: "El yield_adapter no está inicializado." },
  2: { name: "AlreadyInitialized", code: "CONTRACT_ERROR", message: "El yield_adapter ya estaba inicializado." },
  3: { name: "Unauthorized", code: "CONTRACT_ERROR", message: "El Pool no está autorizado en el yield_adapter." },
  4: { name: "InvalidAmount", code: "CONTRACT_ERROR", message: "Monto inválido para el yield_adapter (¿shares demasiado pequeños?)." },
  5: { name: "InsufficientShares", code: "CONTRACT_ERROR", message: "El barrio no tiene suficientes shares en el yield_adapter." },
};

/**
 * Stellar Asset Contract — rs-soroban-env `contract_error.rs`.
 * OJO: NO copiar el mapeo `#7 → InsufficientBalance` de la app (SAC #7 es
 * AccountIsNotClassic). Los relevantes para el faucet son 6/10/11/13.
 */
const SAC_ERRORS: Record<number, ContractErrorSpec> = {
  1: { name: "InternalError", code: "CONTRACT_ERROR", message: "Error interno del SAC." },
  2: { name: "AlreadyInitializedError", code: "CONTRACT_ERROR", message: "SAC ya inicializado." },
  3: { name: "UnauthorizedError", code: "CONTRACT_ERROR", message: "No autorizado en el SAC." },
  4: { name: "AuthenticationError", code: "CONTRACT_ERROR", message: "Error de autenticación en el SAC." },
  5: { name: "AccountMissingError", code: "ACCOUNT_NOT_FOUND", message: "La cuenta no existe en la red." },
  6: { name: "AccountMissingError", code: "ACCOUNT_NOT_FOUND", message: "La cuenta destino no existe en la red (fondéala primero con friendbot)." },
  7: { name: "AccountIsNotClassic", code: "CONTRACT_ERROR", message: "La cuenta no es una cuenta clásica." },
  8: { name: "NegativeAmountError", code: "CONTRACT_ERROR", message: "Monto negativo." },
  9: { name: "AllowanceError", code: "CONTRACT_ERROR", message: "Allowance insuficiente." },
  10: { name: "BalanceError", code: "FAUCET_EMPTY", message: "El faucet no tiene USDC suficiente. Hay que re-fondear la cuenta admin (ver runbook del README)." },
  11: { name: "BalanceDeauthorizedError", code: "TRUSTLINE_DEAUTHORIZED", message: "La trustline USDC de la cuenta destino está desautorizada." },
  12: { name: "OverflowError", code: "CONTRACT_ERROR", message: "Overflow en el SAC." },
  13: { name: "TrustlineMissingError", code: "NO_TRUSTLINE", message: "La cuenta destino no tiene trustline al USDC de Blend. La app debe crearla antes de pedir el faucet." },
};

const TABLES: Partial<Record<ContractRole, Record<number, ContractErrorSpec>>> = {
  pool: POOL_ERRORS,
  governance: GOVERNANCE_ERRORS,
  yield_adapter: ADAPTER_ERRORS,
  usdc_sac: SAC_ERRORS,
};

/** Convierte `(contrato, #N)` en un RelayerError con mensaje en español. */
export function mapContractError(
  contract: ContractRole | "unknown",
  code: number,
  contractId?: string,
): RelayerError {
  const spec = contract !== "unknown" ? TABLES[contract]?.[code] : undefined;
  const details: ErrorDetails = {
    contract,
    contractCode: code,
    ...(contractId ? { contractId } : {}),
    ...(spec ? { name: spec.name } : {}),
  };
  if (spec) return new RelayerError(spec.code, spec.message, details);
  return new RelayerError("CONTRACT_ERROR", `El contrato ${contract} devolvió el error #${code}.`, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de errores de simulación
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_ERROR_RE = /Error\(Contract, #(\d+)\)/;
const CONTRACT_IN_LOG_RE = /contract:\s*(C[A-Z2-7]{55})/g;

export interface SimulationErrorLike {
  error: string;
  events?: xdr.DiagnosticEvent[] | undefined;
}

/**
 * Extrae `#N` y el contractId del frame que falló.
 *
 * Atribución (en orden de preferencia):
 *  1. Eventos de diagnóstico XDR: el PRIMER evento con topic[0] == "error"
 *     que lleve contractId y cuyo topic[1] sea `Error(Contract, #N)` con el
 *     mismo N. Los eventos van en orden de emisión, así que el primero es el
 *     frame más interno (donde nació el error). Si ninguno trae el código,
 *     el primer evento "error" con contractId.
 *  2. Texto del log de la simulación (`Event log (newest first)`): el ÚLTIMO
 *     `contract:C…` listado es el más antiguo = más interno.
 *  3. El contrato invocado (targetContractId).
 */
export function parseContractError(
  sim: SimulationErrorLike,
  targetContractId: string,
): { code: number; contractId: string } | undefined {
  const m = CONTRACT_ERROR_RE.exec(sim.error);
  if (!m?.[1]) return undefined;
  const code = Number.parseInt(m[1], 10);

  const fromEvents = contractFromEvents(sim.events, code);
  if (fromEvents) return { code, contractId: fromEvents };

  const fromLog = contractFromLogText(sim.error);
  if (fromLog) return { code, contractId: fromLog };

  return { code, contractId: targetContractId };
}

function contractFromEvents(events: xdr.DiagnosticEvent[] | undefined, code: number): string | undefined {
  if (!events?.length) return undefined;
  let firstErrorWithContract: string | undefined;
  for (const ev of events) {
    let contractId: string | undefined;
    let isError = false;
    let matchesCode = false;
    try {
      const event = ev.event;
      if (event.contractId != null) {
        contractId = StrKey.encodeContract(event.contractId.toBytes());
      }
      if (event.body.type !== "v0") continue;
      const topics = event.body.v0.topics;
      const t0 = topics[0];
      if (t0?.type === "scvSymbol" && t0.sym.toString() === "error") {
        isError = true;
        const t1 = topics[1];
        if (t1?.type === "scvError" && t1.error.type === "sceContract") {
          matchesCode = t1.error.contractCode === code;
        }
      }
    } catch {
      continue;
    }
    if (isError && contractId) {
      if (matchesCode) return contractId;
      firstErrorWithContract ??= contractId;
    }
  }
  return firstErrorWithContract;
}

function contractFromLogText(text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(CONTRACT_IN_LOG_RE)) {
    if (m[1]) last = m[1];
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultados de transacción (clásica y Soroban)
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre del código de resultado de la tx (`txSuccess`, `txBadSeq`, …). */
export function txResultCodeName(result: xdr.TransactionResult): string {
  try {
    return result.result.type;
  } catch {
    return "unknown";
  }
}

/** Códigos de tx que se resuelven reconstruyendo la transacción (1 intento). */
export const REBUILDABLE_TX_CODES: ReadonlySet<string> = new Set(["txBadSeq", "txTooLate", "txInsufficientFee"]);

/**
 * Para una tx clásica de 1 operación `payment` que falló con `txFailed`,
 * devuelve el nombre del resultado de la operación (`paymentNoTrust`, …), o
 * el del resultado de la operación si no llegó a ejecutarse (`opNoAccount`…).
 */
export function paymentOpResultName(result: xdr.TransactionResult): string | undefined {
  try {
    const r = result.result;
    if (r.type !== "txFailed" && r.type !== "txSuccess") return undefined;
    const op = r.results[0];
    if (!op) return undefined;
    if (op.type !== "opInner") return op.type;
    const tr = op.tr;
    if (tr.type !== "payment") return undefined;
    return tr.paymentResult.type;
  } catch {
    return undefined;
  }
}

/** Mapea el resultado de una operación `payment` a RelayerError. */
export function mapPaymentOpResult(name: string, raw?: string): RelayerError {
  const details: ErrorDetails = { opResult: name, ...(raw ? { txResult: raw } : {}) };
  switch (name) {
    case "paymentNoTrust":
      return new RelayerError("NO_TRUSTLINE", "La cuenta destino no tiene trustline al USDC de Blend. La app debe crearla antes de pedir el faucet.", details);
    case "paymentUnderfunded":
      return new RelayerError("FAUCET_EMPTY", "El faucet no tiene USDC suficiente. Hay que re-fondear la cuenta admin (ver runbook del README).", details);
    case "paymentNoDestination":
    case "opNoAccount":
      return new RelayerError("ACCOUNT_NOT_FOUND", "La cuenta destino no existe en la red (fondéala primero con friendbot).", details);
    case "paymentNotAuthorized":
      return new RelayerError("TRUSTLINE_DEAUTHORIZED", "La trustline USDC de la cuenta destino está desautorizada.", details);
    default:
      return new RelayerError("TX_FAILED", `La transacción falló on-chain (${name}).`, details);
  }
}

/** Decodifica un ScVal devuelto por simulación a nativo, o undefined si no se puede. */
export function safeScValToNative<T = unknown>(v: xdr.ScVal | undefined | null): T | undefined {
  if (v == null) return undefined;
  try {
    return scValToNative(v) as T;
  } catch {
    return undefined;
  }
}
