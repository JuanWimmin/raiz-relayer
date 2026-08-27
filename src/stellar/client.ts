/**
 * Clientes de red del relayer.
 *
 * Solo dos conexiones salientes: el RPC de Soroban (simulación, envío y
 * seguimiento de transacciones, lecturas por simulación) y Horizon (cuentas
 * clásicas: existencia, trustlines y balances). Ambos se crean una sola vez en
 * el bootstrap y se inyectan; los tests pasan objetos falsos con la misma
 * forma (ver `RpcLike` en submit.ts y `HorizonLike` en reads.ts).
 */
import { Horizon, rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";

export interface Clients {
  rpc: rpc.Server;
  horizon: Horizon.Server;
}

/**
 * El timeout de 20 s por petición es deliberadamente menor que el deadline del
 * job (75 s): una llamada colgada nunca debe consumir sola todo el presupuesto
 * de tiempo, y así el bucle de reintentos de submit.ts puede reaccionar.
 */
const RPC_REQUEST_TIMEOUT_MS = 20_000;

export function createClients(config: Config): Clients {
  return {
    rpc: new rpc.Server(config.rpcUrl, { timeout: RPC_REQUEST_TIMEOUT_MS }),
    horizon: new Horizon.Server(config.horizonUrl),
  };
}
