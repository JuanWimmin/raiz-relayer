/**
 * Lecturas previas al envío (preflights) y datos de salud.
 *
 * Todas son puras (no firman ni envían nada) y viven FUERA de la cola: un
 * 404/422 de preflight no debe esperar detrás de un job lento ni quemar cupo
 * de rate-limit. Dos fuentes:
 *  - Horizon para cuentas clásicas (existencia, trustline USDC, balances):
 *    es la API que la app ya usa para el historial y no depende de TTLs.
 *  - RPC por simulación para estado de contratos (`Pool.get_merchant`).
 *    OJO (CLAUDE.md): una lectura sobre entradas con TTL vencido la trata el
 *    host como restore → aquí se traduce a RESTORE_REQUIRED.
 */
import { BASE_FEE, Contract, NotFoundError, TransactionBuilder, rpc as sdkRpc, type Horizon } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import { RelayerError, mapContractError, parseContractError } from "../errors.js";
import type { Logger } from "../logger.js";
import { addressToScVal } from "./encode.js";
import { simulationErrorToRelayerError, type RpcLike } from "./submit.js";

/** Subconjunto de Horizon.Server que usamos; en tests se inyecta un falso. */
export interface HorizonLike {
  loadAccount(accountId: string): Promise<{ balances: Horizon.HorizonApi.BalanceLine[] }>;
}

/** Subconjunto del RPC para networkInfo. */
export interface NetworkRpcLike {
  getNetwork(): Promise<{ passphrase: string; protocolVersion: string | number }>;
  getLatestLedger(): Promise<{ sequence: number }>;
}

export interface HorizonAccountInfo {
  exists: boolean;
  /** Presente solo si la cuenta tiene trustline al USDC del issuer indicado. */
  trustline?: { authorized: boolean; balance: string };
}

const USDC_CODE = "USDC";
/** Código Pool::Error::MerchantNotFound (contracts/pool/src/lib.rs). */
const POOL_MERCHANT_NOT_FOUND = 4;
const DECIMAL_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isHorizonNotFound(e: unknown): boolean {
  if (e instanceof NotFoundError) return true;
  // Cinturón y tirantes: cualquier NetworkError con status 404.
  if (typeof e === "object" && e !== null && "response" in e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    return status === 404;
  }
  return false;
}

function findUsdcLine(
  balances: Horizon.HorizonApi.BalanceLine[],
  issuer: string,
): Horizon.HorizonApi.BalanceLineAsset | undefined {
  for (const b of balances) {
    if ("asset_code" in b && b.asset_code === USDC_CODE && b.asset_issuer === issuer) return b;
  }
  return undefined;
}

/** "341.2700000" (Horizon) → 3412700000n stroops. */
export function decimalToStroops(s: string): bigint {
  const m = DECIMAL_RE.exec(s);
  if (!m?.[1]) throw new RelayerError("INTERNAL", `Balance con formato inesperado: ${s}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(7, "0"));
  return whole * 10_000_000n + frac;
}

/**
 * Existencia y trustline USDC de una cuenta clásica (G…).
 * Cuenta inexistente → `{ exists: false }` (no es error). Horizon caído → RPC_UNREACHABLE.
 */
export async function loadHorizonAccount(
  horizon: HorizonLike,
  address: string,
  usdcIssuer: string,
): Promise<HorizonAccountInfo> {
  let balances: Horizon.HorizonApi.BalanceLine[];
  try {
    balances = (await horizon.loadAccount(address)).balances;
  } catch (e) {
    if (isHorizonNotFound(e)) return { exists: false };
    throw new RelayerError("RPC_UNREACHABLE", "Horizon no responde; reintenta en unos segundos.", {
      stage: "horizon.loadAccount",
      err: errorMessage(e),
    });
  }
  const line = findUsdcLine(balances, usdcIssuer);
  return line ? { exists: true, trustline: { authorized: line.is_authorized, balance: line.balance } } : { exists: true };
}

/** Balance USDC (stroops) de la cuenta admin. Sin trustline → 0n. */
export async function adminUsdcBalanceStroops(horizon: HorizonLike, config: Config): Promise<bigint> {
  const info = await loadHorizonAccount(horizon, config.adminPublicKey, config.usdcIssuer);
  if (!info.exists) {
    // La cuenta que firma no existe: es un error de despliegue, no del cliente.
    throw new RelayerError("INTERNAL", "La cuenta admin del relayer no existe en la red (relayer mal configurado).", {
      admin: config.adminPublicKey,
    });
  }
  if (!info.trustline) return 0n;
  return decimalToStroops(info.trustline.balance);
}

/**
 * ¿Existe ya el comercio en el Pool? Simula `get_merchant(address)`:
 * OK → true · Pool #4 (MerchantNotFound) → false · otro error → como submit.
 */
export async function merchantExists(
  rpc: RpcLike,
  config: Config,
  address: string,
  logger?: Logger,
): Promise<boolean> {
  const pool = config.contracts.pool;
  const arg = addressToScVal(address);

  let account;
  try {
    account = await rpc.getAccount(config.adminPublicKey);
  } catch (e) {
    throw new RelayerError("RPC_UNREACHABLE", "No se pudo contactar con el RPC de Stellar (getAccount).", {
      stage: "getAccount",
      err: errorMessage(e),
    });
  }
  // Solo se simula: la fee y la secuencia no importan, pero la tx debe ser válida.
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(pool).call("get_merchant", arg))
    .setTimeout(config.txTimeoutSeconds)
    .build();

  let sim: sdkRpc.Api.SimulateTransactionResponse;
  try {
    sim = await rpc.simulateTransaction(tx);
  } catch (e) {
    throw new RelayerError("RPC_UNREACHABLE", "No se pudo contactar con el RPC de Stellar (simulateTransaction).", {
      stage: "simulateTransaction",
      err: errorMessage(e),
    });
  }

  if (sdkRpc.Api.isSimulationRestore(sim)) {
    throw new RelayerError(
      "RESTORE_REQUIRED",
      "La entrada del comercio en el Pool tiene el TTL vencido y debe restaurarse antes (ver runbook).",
      { contractId: pool },
    );
  }
  if (sdkRpc.Api.isSimulationError(sim)) {
    const parsed = parseContractError(sim, pool);
    if (parsed) {
      const role = config.rolesByAddress[parsed.contractId] ?? "unknown";
      if (role === "pool" && parsed.code === POOL_MERCHANT_NOT_FOUND) return false;
      throw mapContractError(role, parsed.code, parsed.contractId);
    }
    throw simulationErrorToRelayerError(sim, pool, config, logger, "get_merchant");
  }
  return true;
}

/** Versión de protocolo y último ledger del RPC (health). */
export async function networkInfo(rpc: NetworkRpcLike): Promise<{ protocolVersion: number; latestLedger: number }> {
  try {
    const [net, ledger] = await Promise.all([rpc.getNetwork(), rpc.getLatestLedger()]);
    return { protocolVersion: Number(net.protocolVersion), latestLedger: ledger.sequence };
  } catch (e) {
    throw new RelayerError("RPC_UNREACHABLE", "El RPC de Stellar no responde.", {
      stage: "networkInfo",
      err: errorMessage(e),
    });
  }
}
