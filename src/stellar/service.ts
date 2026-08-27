/**
 * StellarService: la única puerta entre las rutas HTTP y la red.
 *
 * Cada operación sigue el mismo patrón de tres pasos:
 *   1. preflight  — validación de argumentos y lecturas (FUERA de la cola):
 *                   un 400/404/409/422 se responde sin esperar ni firmar nada.
 *   2. hooks.afterPreflight — la ruta consume aquí sus cupos de rate-limit
 *                   (si lanza RATE_LIMITED, no se envía nada).
 *   3. enqueue(submitTransaction) — la cola serializa los envíos del admin.
 *
 * Los ScVal se construyen en el preflight (pueden lanzar VALIDATION_ERROR);
 * el `build` que recibe la cola solo arma la TransactionBuilder con la cuenta
 * fresca. Fees como en la app: 500_000 stroops para Soroban, 1_000 clásico.
 */
import {
  Account,
  Asset,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import { RelayerError } from "../errors.js";
import type { Logger } from "../logger.js";
import { SerialQueue } from "../queue.js";
import type {
  FaucetInput,
  FaucetResult,
  HealthSnapshot,
  MintResidentInput,
  RegisterMerchantInput,
  ServiceHooks,
  StellarService,
  SubmitResult,
  VaultDepositInput,
  VaultRedeemInput,
} from "../types.js";
import { createClients, type Clients } from "./client.js";
import {
  addressToScVal,
  bytes32FromHex,
  bytes32ToScVal,
  i128ToScVal,
  merchantDataToScVal,
  stroopsToDecimal,
} from "./encode.js";
import { adminUsdcBalanceStroops, contractExists, loadHorizonAccount, merchantExists, networkInfo } from "./reads.js";
import { submitTransaction, type SubmitDeps, type SubmitSpec } from "./submit.js";

export interface StellarServiceDeps {
  config: Config;
  adminKeypair: Keypair;
  logger: Logger;
  clients?: Clients;
  queue?: SerialQueue;
}

const SOROBAN_FEE = "500000";
const CLASSIC_FEE = "1000";

export function createStellarService(deps: StellarServiceDeps): StellarService {
  const { config, adminKeypair, logger } = deps;
  const clients = deps.clients ?? createClients(config);
  const queue = deps.queue ?? new SerialQueue({ cap: config.queueCap, jobTimeoutMs: config.jobTimeoutMs, logger });
  const admin = config.adminPublicKey;
  const usdcAsset = new Asset("USDC", config.usdcIssuer);

  const submitDeps: SubmitDeps = { rpc: clients.rpc, keypair: adminKeypair, config, logger };

  const sorobanBuild =
    (contractId: string, method: string, args: xdr.ScVal[]) =>
    (account: Account): Transaction =>
      new TransactionBuilder(account, { fee: SOROBAN_FEE, networkPassphrase: config.networkPassphrase })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(config.txTimeoutSeconds)
        .build();

  const sorobanSpec = (contractId: string, method: string, args: xdr.ScVal[]): SubmitSpec => ({
    kind: "soroban",
    contractId,
    label: method,
    build: sorobanBuild(contractId, method, args),
  });

  const run = (spec: SubmitSpec, hooks: ServiceHooks | undefined): Promise<SubmitResult> => {
    const label = spec.label ?? spec.kind;
    // Capacidad ANTES del hook: afterPreflight consume el cupo de rate-limit,
    // y un QUEUE_FULL (503) no debe quemar el turno de 10 min del cliente.
    // assertCapacity y enqueue van en el mismo tick síncrono, así que si el
    // primero pasa, el segundo no puede rechazar por cupo.
    queue.assertCapacity(label);
    hooks?.afterPreflight?.();
    return queue.enqueue(() => submitTransaction(submitDeps, spec), label);
  };

  const assertAddress = (address: string): { isContract: boolean } => {
    if (StrKey.isValidContract(address)) return { isContract: true };
    if (StrKey.isValidEd25519PublicKey(address)) return { isContract: false };
    throw new RelayerError("VALIDATION_ERROR", "address debe ser una cuenta G… o un contrato C… válido.", {
      field: "address",
    });
  };

  return {
    async registerMerchant(input: RegisterMerchantInput, hooks?: ServiceHooks): Promise<SubmitResult> {
      assertAddress(input.address);
      // `verified` lo fija el servidor (como hoy la app): no lo decide el cliente.
      const data = merchantDataToScVal({ ...input, verified: true });
      if (await merchantExists(clients.rpc, config, input.address, logger)) {
        throw new RelayerError("MERCHANT_EXISTS", "Este comercio ya está registrado; re-registrarlo requiere intervención del admin.", {
          address: input.address,
        });
      }
      return run(sorobanSpec(config.contracts.pool, "register_merchant", [data]), hooks);
    },

    async mintResident(input: MintResidentInput, hooks?: ServiceHooks): Promise<SubmitResult> {
      const resident = addressToScVal(input.address);
      const barrio = bytes32ToScVal(bytes32FromHex(input.barrioId));
      return run(sorobanSpec(config.contracts.governance, "mint_resident", [addressToScVal(admin), resident, barrio]), hooks);
    },

    async faucet(input: FaucetInput, hooks?: ServiceHooks): Promise<FaucetResult> {
      const { address } = input;
      const { isContract } = assertAddress(address);
      const amount = config.faucetAmountStroops;

      if (isContract) {
        // C…: cualquier strkey válida "parece" una smart account, pero el SAC
        // transfiere a direcciones sin desplegar igual (USDC irrecuperable) y
        // eso evadiría la ventana por address con C… aleatorios. Preflight de
        // existencia antes de nada.
        if (!(await contractExists(clients.rpc, address, logger))) {
          throw new RelayerError("ACCOUNT_NOT_FOUND", "El contrato destino no existe en la red (despliega la smart account primero).", {
            address,
          });
        }
      } else {
        // G…: Horizon nos dice de antemano lo que la op `payment` fallaría on-chain.
        const info = await loadHorizonAccount(clients.horizon, address, config.usdcIssuer, logger);
        if (!info.exists) {
          throw new RelayerError("ACCOUNT_NOT_FOUND", "La cuenta destino no existe en la red (fondéala primero con friendbot).", {
            address,
          });
        }
        if (!info.trustline) {
          throw new RelayerError("NO_TRUSTLINE", "La cuenta destino no tiene trustline al USDC de Blend. La app debe crearla antes de pedir el faucet.", {
            address,
            asset: `USDC:${config.usdcIssuer}`,
          });
        }
        if (!info.trustline.authorized) {
          throw new RelayerError("TRUSTLINE_DEAUTHORIZED", "La trustline USDC de la cuenta destino está desautorizada.", {
            address,
          });
        }
      }

      const balance = await adminUsdcBalanceStroops(clients.horizon, config, logger);
      if (balance < amount) {
        logger.error({ adminUsdcStroops: balance.toString(), needed: amount.toString() }, "faucet: sin fondos");
        throw new RelayerError("FAUCET_EMPTY", "El faucet no tiene USDC suficiente. Hay que re-fondear la cuenta admin (ver runbook del README).", {
          adminUsdcStroops: balance.toString(),
          amountStroops: amount.toString(),
        });
      }

      let spec: SubmitSpec;
      let method: FaucetResult["method"];
      if (isContract) {
        // C… (smart account): no tiene trustline clásica, se transfiere vía SAC.
        method = "sac_transfer";
        spec = sorobanSpec(config.contracts.usdc_sac, "transfer", [
          addressToScVal(admin),
          addressToScVal(address),
          i128ToScVal(amount),
        ]);
      } else {
        // G…: op `payment` clásica, así aparece en el historial de Horizon de la app.
        method = "payment";
        const amountDecimal = stroopsToDecimal(amount);
        spec = {
          kind: "classic",
          label: "faucet_payment",
          build: (account: Account) =>
            new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase: config.networkPassphrase })
              .addOperation(Operation.payment({ destination: address, asset: usdcAsset, amount: amountDecimal }))
              .setTimeout(config.txTimeoutSeconds)
              .build(),
        };
      }

      const result = await run(spec, hooks);
      return { ...result, amountStroops: amount.toString(), asset: `USDC:${config.usdcIssuer}`, method };
    },

    async vaultDeposit(input: VaultDepositInput, hooks?: ServiceHooks): Promise<SubmitResult> {
      const barrio = bytes32ToScVal(bytes32FromHex(input.barrioId));
      const amount = i128ToScVal(input.amountStroops);
      return run(sorobanSpec(config.contracts.pool, "deposit_idle_to_vault", [addressToScVal(admin), barrio, amount]), hooks);
    },

    async vaultRedeem(input: VaultRedeemInput, hooks?: ServiceHooks): Promise<SubmitResult> {
      const barrio = bytes32ToScVal(bytes32FromHex(input.barrioId));
      const shares = i128ToScVal(input.shares);
      return run(sorobanSpec(config.contracts.pool, "redeem_from_vault", [addressToScVal(admin), barrio, shares]), hooks);
    },

    async health(): Promise<HealthSnapshot> {
      const [net, adminUsdc] = await Promise.all([
        networkInfo(clients.rpc, logger),
        adminUsdcBalanceStroops(clients.horizon, config, logger),
      ]);
      return { protocolVersion: net.protocolVersion, latestLedger: net.latestLedger, adminUsdcStroops: adminUsdc.toString() };
    },

    queuePending(): number {
      return queue.pending();
    },
  };
}
