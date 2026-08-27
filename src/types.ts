/**
 * Tipos compartidos entre la capa HTTP (routes) y la capa Stellar (service).
 * La capa HTTP SOLO conoce `StellarService`; los tests de rutas inyectan un
 * servicio falso que implementa esta interfaz.
 */

export const MERCHANT_CATEGORIES = [
  "cafe",
  "restaurante",
  "artesania",
  "tienda",
  "cultura",
  "hospedaje",
  "otro",
] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

export interface SubmitResult {
  /** Hash hex (64) de la transacción aplicada. */
  txHash: string;
  /** Ledger en el que se aplicó. */
  ledger: number;
}

export interface RegisterMerchantInput {
  /** G… o C… */
  address: string;
  /** 2..40 chars, sin caracteres de control. */
  name: string;
  /** hex de 64 chars (BytesN<32>). */
  barrioId: string;
  latE6: number;
  lngE6: number;
  category: MerchantCategory;
}

export interface MintResidentInput {
  address: string;
  barrioId: string;
}

export interface FaucetInput {
  address: string;
}

export interface FaucetResult extends SubmitResult {
  amountStroops: string;
  /** "USDC:G…" (code:issuer). */
  asset: string;
  /** `payment` (G…, op clásica) o `sac_transfer` (C…, SAC transfer). */
  method: "payment" | "sac_transfer";
}

export interface VaultDepositInput {
  barrioId: string;
  amountStroops: bigint;
}

export interface VaultRedeemInput {
  barrioId: string;
  shares: bigint;
}

export interface HealthSnapshot {
  protocolVersion: number;
  latestLedger: number;
  /** Balance USDC (stroops) de la cuenta admin, como string decimal. */
  adminUsdcStroops: string;
}

/**
 * Hooks que la capa HTTP pasa al servicio.
 *
 * `afterPreflight` se invoca cuando las validaciones y lecturas previas han
 * pasado y JUSTO ANTES de encolar el submit. Ahí es donde la ruta consume los
 * cupos de rate-limit: un 400/404/422 de preflight no quema cupo, pero un
 * TX_TIMEOUT que luego se aplica sí lo consumió. Si el hook lanza
 * (p. ej. RATE_LIMITED), el servicio aborta sin enviar nada.
 */
export interface ServiceHooks {
  afterPreflight?: () => void;
}

export interface StellarService {
  registerMerchant(input: RegisterMerchantInput, hooks?: ServiceHooks): Promise<SubmitResult>;
  mintResident(input: MintResidentInput, hooks?: ServiceHooks): Promise<SubmitResult>;
  faucet(input: FaucetInput, hooks?: ServiceHooks): Promise<FaucetResult>;
  vaultDeposit(input: VaultDepositInput, hooks?: ServiceHooks): Promise<SubmitResult>;
  vaultRedeem(input: VaultRedeemInput, hooks?: ServiceHooks): Promise<SubmitResult>;
  /** Lanza RelayerError(RPC_UNREACHABLE) si el RPC/Horizon no responden. */
  health(): Promise<HealthSnapshot>;
  /** Jobs esperando o en curso en la cola serializada. */
  queuePending(): number;
}
