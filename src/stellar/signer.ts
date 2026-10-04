/**
 * Autoridad del firmante sobre la cuenta admin.
 *
 * El relayer firma con la clave de RELAYER_ADMIN_SECRET (`signerPublicKey`),
 * que puede ser la maestra de la cuenta admin (`adminPublicKey` =
 * deployments.admin) o un firmante añadido a ella: al rotar la clave la cuenta
 * conserva su dirección —los contratos la guardan como admin—, la maestra
 * queda con peso 0 y firma el firmante nuevo. Que una clave PUEDA firmar por
 * la cuenta no se deduce del secret: está en el ledger (`signers` y
 * `thresholds` de la cuenta). Este módulo lo lee de Horizon; lo usan el
 * bootstrap (index.ts, antes de escuchar) y cada refresco de /v1/health.
 *
 * Regla (stellar-core): una firma cuenta si su clave está entre los firmantes
 * de la cuenta con peso > 0. La transacción se valida contra el umbral BAJO y
 * cada operación contra el suyo; `payment` e `invoke_host_function` —lo único
 * que envía el relayer— son de umbral MEDIO. Con umbral 0 sigue haciendo falta
 * una firma válida, así que el peso mínimo es max(1, bajo, medio): en una
 * cuenta normal (bajo ≤ medio) manda el medio. Horizon lista la clave maestra
 * en `signers` aunque tenga peso 0 (deshabilitada).
 *
 * Resultado discriminado, nunca una excepción:
 *  - authorized   → la clave puede firmar pagos e invocaciones por la cuenta.
 *  - unauthorized → respuesta DEFINITIVA de Horizon: la cuenta no existe, la
 *                   clave no es firmante, tiene peso 0 o no llega al umbral.
 *  - unknown      → Horizon no contestó (o contestó algo ilegible) tras los
 *                   reintentos: no se sabe.
 *
 * Aquí solo viajan claves PÚBLICAS (G…): nada de esto toca el secret.
 */
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { isHorizonNotFound } from "./reads.js";

/** Lo que se lee de la cuenta admin (subconjunto de la respuesta de Horizon). */
export interface SignerAccountLike {
  signers: Array<{ key: string; weight: number }>;
  thresholds: { low_threshold: number; med_threshold: number };
}

/** Subconjunto de Horizon.Server que usa la verificación; en tests se inyecta un falso. */
export interface SignerHorizonLike {
  loadAccount(accountId: string): Promise<SignerAccountLike>;
}

/** Las dos claves públicas en juego: la cuenta y quien firma (ver config.ts). */
export type SignerKeys = Pick<Config, "adminPublicKey" | "signerPublicKey">;

export type SignerUnauthorizedReason = "account_not_found" | "not_a_signer" | "zero_weight" | "below_threshold";

export type SignerAuthority =
  /** `weight` del firmante y peso mínimo `required` que exige la cuenta. */
  | { status: "authorized"; weight: number; required: number }
  /** `message`: frase en español con la cuenta, el firmante y el porqué. */
  | { status: "unauthorized"; reason: SignerUnauthorizedReason; message: string }
  | { status: "unknown"; message: string };

export interface VerifySignerOptions {
  /** Cargas de la cuenta antes de rendirse (≥ 1). Por defecto 3. */
  attempts?: number;
  /** Espera tras el intento fallido n: `backoffMs * n`. Por defecto 1 s (1 s, 2 s). */
  backoffMs?: number;
  /** Sleep inyectable: en tests no duerme. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/**
 * Pocos reintentos y backoff corto: cada carga ya está acotada por el timeout
 * HTTP del cliente de Horizon (`rpcRequestTimeoutMs`), así que con Horizon
 * colgado el arranque espera como mucho 3 × 15 s + 3 s con los defaults.
 */
const VERIFY_ATTEMPTS = 3;
const VERIFY_BACKOFF_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unauthorized(
  reason: SignerUnauthorizedReason,
  keys: SignerKeys,
  why: string,
): Extract<SignerAuthority, { status: "unauthorized" }> {
  return {
    status: "unauthorized",
    reason,
    message: `La clave de RELAYER_ADMIN_SECRET (${keys.signerPublicKey}) no puede firmar por la cuenta admin ${keys.adminPublicKey}: ${why}`,
  };
}

/**
 * ¿La respuesta trae lo que se va a comparar, con los tipos esperados? Sin
 * esto, un `thresholds` ausente daría NaN y toda comparación con NaN es
 * falsa: se colaría un "authorized" sin haber comprobado nada.
 */
function isSignerAccount(account: unknown): account is SignerAccountLike {
  if (typeof account !== "object" || account === null) return false;
  const { signers, thresholds } = account as { signers?: unknown; thresholds?: Record<string, unknown> | null };
  if (!Array.isArray(signers) || typeof thresholds !== "object" || thresholds === null) return false;
  if (!Number.isFinite(thresholds["low_threshold"]) || !Number.isFinite(thresholds["med_threshold"])) return false;
  return signers.every((s: unknown) => {
    if (typeof s !== "object" || s === null) return false;
    const { key, weight } = s as { key?: unknown; weight?: unknown };
    return typeof key === "string" && Number.isFinite(weight);
  });
}

/**
 * Decisión pura sobre una cuenta ya cargada: ¿el firmante alcanza el peso que
 * la cuenta exige para las transacciones del relayer?
 */
export function evaluateSignerAuthority(
  account: SignerAccountLike,
  keys: SignerKeys,
): Exclude<SignerAuthority, { status: "unknown" }> {
  const low = account.thresholds.low_threshold;
  const med = account.thresholds.med_threshold;
  const required = Math.max(1, low, med);
  const isMaster = keys.signerPublicKey === keys.adminPublicKey;

  const entry = account.signers.find((s) => s.key === keys.signerPublicKey);
  if (!entry) {
    return unauthorized("not_a_signer", keys, "no figura entre los firmantes (signers) de la cuenta.");
  }
  if (entry.weight <= 0) {
    return unauthorized(
      "zero_weight",
      keys,
      isMaster
        ? "es la clave maestra de la cuenta y está deshabilitada (peso 0); hay que configurar la clave de un firmante vigente."
        : "figura entre los firmantes con peso 0.",
    );
  }
  if (entry.weight < required) {
    return unauthorized(
      "below_threshold",
      keys,
      `su peso (${entry.weight}) no alcanza el que exigen las transacciones del relayer (${required}; umbrales de la cuenta: bajo ${low}, medio ${med}).`,
    );
  }
  return { status: "authorized", weight: entry.weight, required };
}

/**
 * Carga la cuenta admin de Horizon y decide si `signerPublicKey` puede firmar
 * por ella. Nunca lanza: un 404 es definitivo (`unauthorized`: no se puede
 * firmar por una cuenta que no existe) y cualquier otro fallo se reintenta
 * `attempts` veces antes de devolver `unknown`.
 */
export async function verifySignerAuthority(
  horizon: SignerHorizonLike,
  keys: SignerKeys,
  opts: VerifySignerOptions = {},
): Promise<SignerAuthority> {
  const attempts = Math.max(1, opts.attempts ?? VERIFY_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? VERIFY_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const stage = "horizon.loadAccount";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let failure: string;
    try {
      const account: unknown = await horizon.loadAccount(keys.adminPublicKey);
      if (isSignerAccount(account)) return evaluateSignerAuthority(account, keys);
      failure = "respuesta de Horizon sin signers/thresholds válidos";
    } catch (e) {
      if (isHorizonNotFound(e)) {
        return unauthorized(
          "account_not_found",
          keys,
          "la cuenta no existe en la red (¿deployments desactualizado, reset de testnet u HORIZON_URL equivocada?).",
        );
      }
      failure = errorMessage(e);
    }
    opts.logger?.warn({ stage, attempt, attempts, err: failure }, "firmante: no se pudo leer la cuenta admin en Horizon");
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }

  return {
    status: "unknown",
    message:
      `No se pudo verificar en Horizon que la clave de RELAYER_ADMIN_SECRET (${keys.signerPublicKey}) ` +
      `puede firmar por la cuenta admin ${keys.adminPublicKey} (${attempts} intento(s) sin respuesta válida).`,
  };
}
