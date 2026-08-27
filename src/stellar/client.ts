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
 * El timeout por petición (`config.rpcRequestTimeoutMs`, 15 s por defecto) es
 * deliberadamente menor que el deadline del job (70 s): una llamada colgada
 * nunca debe consumir sola todo el presupuesto de tiempo, y submit.ts solo
 * inicia una llamada si le queda más que ese timeout (ensureBudget). Se aplica
 * a los DOS clientes: Horizon.Server no acepta `timeout` en el constructor,
 * pero su httpClient (fetch) lo lee de `defaults` en cada petición.
 */
export function createClients(config: Config): Clients {
  const horizon = new Horizon.Server(config.horizonUrl);
  horizon.httpClient.defaults.timeout = config.rpcRequestTimeoutMs;
  return {
    rpc: new rpc.Server(config.rpcUrl, { timeout: config.rpcRequestTimeoutMs }),
    horizon,
  };
}
