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
 *    host como restore. Para una LECTURA eso significa que la entrada existe
 *    (archivada): se responde con el dato, no con RESTORE_REQUIRED, que se
 *    reserva para el submit (ahí sí hay que restaurar antes de escribir).
 *  - RPC `getLedgerEntries` (vía getContractInstance) para saber si un C…
 *    existe antes de transferirle USDC por el SAC.
 *
 * Ningún mensaje crudo de red llega al cliente: los RPC_UNREACHABLE llevan
 * solo `{ stage }` en details y el texto del error va al log (warn).
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

/**
 * Subconjunto del RPC para contractExists. `rpc.Server.getContractInstance`
 * devuelve la instancia (ScContractInstance) o RECHAZA con un objeto plano
 * `{ code: 404, message: "Could not obtain contract instance from server" }`
 * (no un Error) cuando getLedgerEntries no trae la entrada. El valor no nos
 * interesa, solo si existe.
 */
export interface ContractRpcLike {
  getContractInstance(contractId: string): Promise<unknown>;
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

/**
 * ¿El rechazo de getContractInstance significa "no existe"? El SDK 17 rechaza
 * con `{ code: 404, message }` (objeto plano) tanto si la entrada no está como
 * si no es una instancia de contrato; cualquier otra cosa es fallo de red.
 */
function isContractNotFound(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code === 404) return true;
  return typeof message === "string" && /not found|could not obtain contract instance|expected contract/i.test(message);
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
  logger?: Logger,
): Promise<HorizonAccountInfo> {
  let balances: Horizon.HorizonApi.BalanceLine[];
  try {
    balances = (await horizon.loadAccount(address)).balances;
  } catch (e) {
    if (isHorizonNotFound(e)) return { exists: false };
    const stage = "horizon.loadAccount";
    logger?.warn({ stage, err: errorMessage(e) }, "horizon: fallo de red");
    throw new RelayerError("RPC_UNREACHABLE", "Horizon no responde; reintenta en unos segundos.", { stage });
  }
  const line = findUsdcLine(balances, usdcIssuer);
  return line ? { exists: true, trustline: { authorized: line.is_authorized, balance: line.balance } } : { exists: true };
}

/** Balance USDC (stroops) de la cuenta admin. Sin trustline → 0n. */
export async function adminUsdcBalanceStroops(horizon: HorizonLike, config: Config, logger?: Logger): Promise<bigint> {
  const info = await loadHorizonAccount(horizon, config.adminPublicKey, config.usdcIssuer, logger);
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
 * ¿Existe el contrato `address` en la red? Un C… es válido como strkey sin que
 * nadie lo haya desplegado, y el SAC acepta transferir USDC a cualquier
 * dirección: sin este preflight, un faucet a un C… inventado quema 20 USDC
 * irrecuperables (y evade la ventana por address con C… aleatorios).
 * No existe → false · RPC caído → RPC_UNREACHABLE.
 */
export async function contractExists(rpc: ContractRpcLike, address: string, logger?: Logger): Promise<boolean> {
  try {
    await rpc.getContractInstance(address);
    return true;
  } catch (e) {
    if (isContractNotFound(e)) return false;
    const stage = "getContractInstance";
    logger?.warn({ stage, err: errorMessage(e) }, "rpc: fallo de red");
    throw new RelayerError("RPC_UNREACHABLE", "No se pudo contactar con el RPC de Stellar (getContractInstance).", {
      stage,
    });
  }
}

/**
 * ¿Existe ya el comercio en el Pool? Simula `get_merchant(address)`:
 * OK → true · restore requerido → true (existe, archivado) ·
 * Pool #4 (MerchantNotFound) → false · otro error → como submit.
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
    const stage = "getAccount";
    logger?.warn({ stage, err: errorMessage(e) }, "rpc: fallo de red");
    throw new RelayerError("RPC_UNREACHABLE", "No se pudo contactar con el RPC de Stellar (getAccount).", { stage });
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
    const stage = "simulateTransaction";
    logger?.warn({ stage, err: errorMessage(e) }, "rpc: fallo de red");
    throw new RelayerError("RPC_UNREACHABLE", "No se pudo contactar con el RPC de Stellar (simulateTransaction).", {
      stage,
    });
  }

  if (sdkRpc.Api.isSimulationRestore(sim)) {
    // El host pide restaurar la entrada del comercio: la lectura en sí fue OK,
    // luego el comercio EXISTE (con TTL vencido). Para un preflight eso es
    // suficiente; RESTORE_REQUIRED se reserva para el submit.
    logger?.warn({ contractId: pool, address }, "get_merchant: entrada archivada (TTL vencido); se trata como existente");
    return true;
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
export async function networkInfo(
  rpc: NetworkRpcLike,
  logger?: Logger,
): Promise<{ protocolVersion: number; latestLedger: number }> {
  try {
    const [net, ledger] = await Promise.all([rpc.getNetwork(), rpc.getLatestLedger()]);
    return { protocolVersion: Number(net.protocolVersion), latestLedger: ledger.sequence };
  } catch (e) {
    const stage = "networkInfo";
    logger?.warn({ stage, err: errorMessage(e) }, "rpc: fallo de red");
    throw new RelayerError("RPC_UNREACHABLE", "El RPC de Stellar no responde.", { stage });
  }
}
