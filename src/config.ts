/**
 * Configuración del relayer: variables de entorno + deployments.json.
 *
 * Reglas duras (el proceso NO arranca si fallan):
 *  - RELAYER_ADMIN_SECRET presente y válido (S…), y su clave pública debe
 *    coincidir con `admin` de deployments.json (un secret equivocado no firma
 *    nada por error).
 *  - NETWORK === "testnet". Este servicio no está pensado para mainnet.
 *  - RELAYER_APP_KEY de al menos 16 caracteres.
 *
 * El secret nunca sale de este módulo como string: `loadConfig()` devuelve el
 * Keypair aparte del objeto `Config` (que sí puede loguearse).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { ContractRole } from "./errors.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const NETWORK_PASSPHRASES = {
  testnet: Networks.TESTNET,
} as const;

/** Margen entre el peor caso del submit (deadline + una llamada RPC colgada) y el timeout duro de la cola. */
const JOB_TIMEOUT_MARGIN_MS = 5_000;

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v)));

const intFromEnv = (def: number, min = 0) =>
  z.coerce.number().int().min(min).default(def);

const envSchema = z.object({
  NETWORK: z.literal("testnet", {
    error: "NETWORK debe ser exactamente 'testnet' (este relayer no soporta mainnet).",
  }),
  RELAYER_ADMIN_SECRET: z
    .string({ error: "Falta RELAYER_ADMIN_SECRET (clave S… del admin del protocolo)." })
    .refine((s) => StrKey.isValidEd25519SecretSeed(s), {
      message: "RELAYER_ADMIN_SECRET no es una seed ed25519 válida (S…).",
    }),
  RELAYER_APP_KEY: z
    .string({ error: "Falta RELAYER_APP_KEY (API key estática que usa la app)." })
    .min(16, "RELAYER_APP_KEY debe tener al menos 16 caracteres."),
  RPC_URL: z.url().default("https://soroban-testnet.stellar.org"),
  HORIZON_URL: z.url().default("https://horizon-testnet.stellar.org"),
  PORT: intFromEnv(8080, 1),
  HOST: z.string().default("0.0.0.0"),
  FAUCET_AMOUNT_STROOPS: z
    .string()
    .regex(/^\d+$/, "FAUCET_AMOUNT_STROOPS debe ser un entero decimal en stroops.")
    .default("200000000"),
  RATE_FAUCET_PER_ADDRESS_MINUTES: intFromEnv(10, 1),
  RATE_FAUCET_DAILY: intFromEnv(50, 1),
  RATE_REGISTER_DAILY: intFromEnv(20, 1),
  RATE_MINT_DAILY: intFromEnv(20, 1),
  RATE_VAULT_DAILY: intFromEnv(20, 1),
  RATE_PER_IP_PER_MINUTE: intFromEnv(60, 1),
  VAULT_ENDPOINTS_ENABLED: boolFromEnv,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEPLOYMENTS_FILE: z.string().default("config/deployments.testnet.json"),
  QUEUE_CAP: intFromEnv(20, 1),
  JOB_DEADLINE_MS: intFromEnv(70_000, 5_000),
  JOB_TIMEOUT_MS: intFromEnv(90_000, 5_000),
  RPC_REQUEST_TIMEOUT_MS: intFromEnv(15_000, 1_000),
  SUBMIT_ATTEMPTS: intFromEnv(5, 1),
  SUBMIT_BACKOFF_MS: intFromEnv(3_000, 0),
  TX_TIMEOUT_SECONDS: intFromEnv(30, 10),
  IDEMPOTENCY_TTL_MS: intFromEnv(600_000, 1_000),
  HEALTH_CACHE_MS: intFromEnv(10_000, 0),
});

const deploymentsSchema = z.object({
  network: z.literal("testnet"),
  admin: z.string().refine(StrKey.isValidEd25519PublicKey, "deployments.admin no es una G… válida"),
  usdc_sac: z.string().refine(StrKey.isValidContract, "deployments.usdc_sac no es un C… válido"),
  usdc_issuer: z.string().refine(StrKey.isValidEd25519PublicKey, "deployments.usdc_issuer no es una G… válida"),
  pool: z.string().refine(StrKey.isValidContract),
  governance: z.string().refine(StrKey.isValidContract),
  treasury: z.string().refine(StrKey.isValidContract),
  rewards: z.string().refine(StrKey.isValidContract),
  yield_adapter: z.string().refine(StrKey.isValidContract),
  blend_pool: z.string().refine(StrKey.isValidContract).optional(),
  deployed_at: z.string().optional(),
});
export type Deployments = z.infer<typeof deploymentsSchema>;

/** Contratos que el relayer puede INVOCAR (allowlist explícita; nunca Object.values). */
export const INVOKABLE_ROLES = ["pool", "governance", "treasury", "rewards", "yield_adapter", "usdc_sac"] as const;
export type InvokableRole = (typeof INVOKABLE_ROLES)[number];

export interface RateConfig {
  faucetPerAddressWindowMs: number;
  faucetDaily: number;
  registerDaily: number;
  mintDaily: number;
  vaultDaily: number;
  perIpPerMinute: number;
}

export interface Config {
  version: string;
  network: "testnet";
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  port: number;
  host: string;
  /** Clave pública del admin (= deployments.admin). */
  adminPublicKey: string;
  appKey: string;
  faucetAmountStroops: bigint;
  usdcIssuer: string;
  rates: RateConfig;
  vaultEndpointsEnabled: boolean;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  deployments: Deployments;
  /** address → rol, para atribuir errores de contrato (incluye blend_pool). */
  rolesByAddress: Record<string, ContractRole>;
  /** rol → address, solo los invocables. */
  contracts: Record<InvokableRole, string>;
  queueCap: number;
  /** Presupuesto de tiempo del pipeline de submit (por job). */
  jobDeadlineMs: number;
  /** Red de seguridad de la cola: debe cubrir deadline + una llamada RPC colgada + margen. */
  jobTimeoutMs: number;
  /** Timeout HTTP de cada petición al RPC y a Horizon. */
  rpcRequestTimeoutMs: number;
  submitAttempts: number;
  submitBackoffMs: number;
  txTimeoutSeconds: number;
  idempotencyTtlMs: number;
  healthCacheMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(prefix: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `${prefix}\n${lines.join("\n")}`;
}

export function loadDeployments(path: string): Deployments {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`No se pudo leer DEPLOYMENTS_FILE=${path}: ${(e as Error).message}`);
  }
  const parsed = deploymentsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new ConfigError(formatZodError(`deployments inválido (${path}):`, parsed.error));
  return parsed.data;
}

/**
 * Carga y valida la configuración. Lanza ConfigError con mensaje claro; el
 * bootstrap lo imprime y sale con código 1.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: Config; adminKeypair: Keypair } {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(formatZodError("Configuración inválida:", parsed.error));
  const e = parsed.data;

  const deployments = loadDeployments(e.DEPLOYMENTS_FILE);

  const adminKeypair = Keypair.fromSecret(e.RELAYER_ADMIN_SECRET);
  if (adminKeypair.publicKey() !== deployments.admin) {
    throw new ConfigError(
      `RELAYER_ADMIN_SECRET deriva a ${adminKeypair.publicKey()} pero deployments.admin es ${deployments.admin}. ` +
        "El relayer solo firma con la cuenta admin del despliegue vigente.",
    );
  }

  const contracts: Record<InvokableRole, string> = {
    pool: deployments.pool,
    governance: deployments.governance,
    treasury: deployments.treasury,
    rewards: deployments.rewards,
    yield_adapter: deployments.yield_adapter,
    usdc_sac: deployments.usdc_sac,
  };
  const rolesByAddress: Record<string, ContractRole> = {};
  for (const role of INVOKABLE_ROLES) rolesByAddress[contracts[role]] = role;
  if (deployments.blend_pool) rolesByAddress[deployments.blend_pool] = "blend_pool";

  const config: Config = {
    version: pkg.version,
    network: "testnet",
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
    rpcUrl: e.RPC_URL,
    horizonUrl: e.HORIZON_URL,
    port: e.PORT,
    host: e.HOST,
    adminPublicKey: adminKeypair.publicKey(),
    appKey: e.RELAYER_APP_KEY,
    faucetAmountStroops: BigInt(e.FAUCET_AMOUNT_STROOPS),
    usdcIssuer: deployments.usdc_issuer,
    rates: {
      faucetPerAddressWindowMs: e.RATE_FAUCET_PER_ADDRESS_MINUTES * 60_000,
      faucetDaily: e.RATE_FAUCET_DAILY,
      registerDaily: e.RATE_REGISTER_DAILY,
      mintDaily: e.RATE_MINT_DAILY,
      vaultDaily: e.RATE_VAULT_DAILY,
      perIpPerMinute: e.RATE_PER_IP_PER_MINUTE,
    },
    vaultEndpointsEnabled: e.VAULT_ENDPOINTS_ENABLED ?? true,
    logLevel: e.LOG_LEVEL,
    deployments,
    rolesByAddress,
    contracts,
    queueCap: e.QUEUE_CAP,
    jobDeadlineMs: e.JOB_DEADLINE_MS,
    jobTimeoutMs: e.JOB_TIMEOUT_MS,
    rpcRequestTimeoutMs: e.RPC_REQUEST_TIMEOUT_MS,
    submitAttempts: e.SUBMIT_ATTEMPTS,
    submitBackoffMs: e.SUBMIT_BACKOFF_MS,
    txTimeoutSeconds: e.TX_TIMEOUT_SECONDS,
    idempotencyTtlMs: e.IDEMPOTENCY_TTL_MS,
    healthCacheMs: e.HEALTH_CACHE_MS,
  };
  if (config.faucetAmountStroops <= 0n) throw new ConfigError("FAUCET_AMOUNT_STROOPS debe ser > 0.");
  // submit.ts solo inicia una llamada RPC si quedan > rpcRequestTimeoutMs de
  // deadline, y cada llamada está acotada por ese timeout HTTP: el job termina
  // como muy tarde en deadline + timeout. El timeout de la cola debe cubrir
  // eso con margen; si no, la cola respondería TX_TIMEOUT (txHash null)
  // mientras el submit sigue vivo y podría incluso enviar un envelope nuevo.
  const minJobTimeoutMs = config.jobDeadlineMs + config.rpcRequestTimeoutMs + JOB_TIMEOUT_MARGIN_MS;
  if (config.jobTimeoutMs < minJobTimeoutMs) {
    throw new ConfigError(
      `JOB_TIMEOUT_MS (${config.jobTimeoutMs}) debe ser >= JOB_DEADLINE_MS + RPC_REQUEST_TIMEOUT_MS + ${JOB_TIMEOUT_MARGIN_MS} ` +
        `(= ${config.jobDeadlineMs} + ${config.rpcRequestTimeoutMs} + ${JOB_TIMEOUT_MARGIN_MS} = ${minJobTimeoutMs}).`,
    );
  }
  return { config, adminKeypair };
}

/** Versión segura para logs (sin appKey; URLs reducidas al origen por si llevan credenciales o tokens en el path). */
export function redactConfig(c: Config): Record<string, unknown> {
  const { appKey: _appKey, deployments: _d, rolesByAddress: _r, ...rest } = c;
  // rpcUrl/horizonUrl ya pasaron z.url(), así que `new URL` no lanza.
  return {
    ...rest,
    rpcUrl: new URL(c.rpcUrl).origin,
    horizonUrl: new URL(c.horizonUrl).origin,
    faucetAmountStroops: c.faucetAmountStroops.toString(),
  };
}
