/**
 * Validación de bodies (zod v4). Espejo de plan §2: nombres de campos y
 * rangos son contrato con la app (sesión B).
 *
 * Los montos i128 viajan como string decimal (JSON no tiene enteros de 128
 * bits) y se convierten a bigint aquí; la capa Stellar nunca ve floats.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { RelayerError } from "./errors.js";
import { MERCHANT_CATEGORIES } from "./types.js";

/* Mensajes por defecto de zod en español (los custom ya lo están). Es un
 * ajuste global del proceso; config.ts también se beneficia. */
z.config(z.locales.es());

/** G… (cuenta) o C… (contrato): lo que devuelve `currentAccountId()` en la app. */
export const strkey = z
  .string()
  .refine((s) => StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s), "address debe ser G… o C…");

/** BytesN<32> en hex (barrio_id). */
export const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/, "debe ser hex de 64 caracteres");

export const category = z.enum(MERCHANT_CATEGORIES);

/** 2..40 chars tras trim, sin caracteres de control (categoría Unicode Cc). */
export const name = z
  .string()
  .trim()
  .min(2, "debe tener al menos 2 caracteres")
  .max(40, "debe tener como máximo 40 caracteres")
  .refine((s) => !/[\p{Cc}]/u.test(s), "no puede contener caracteres de control");

export const latE6 = z.number().int().min(-90_000_000).max(90_000_000);
export const lngE6 = z.number().int().min(-180_000_000).max(180_000_000);

/** i128 positivo como string decimal (≤ 39 dígitos) → bigint. */
const i128Positive = z
  .string()
  .regex(/^[1-9]\d{0,38}$/, "debe ser un entero positivo en stroops, como string decimal sin ceros a la izquierda")
  .transform((s) => BigInt(s));

export const amountStroops = i128Positive;
export const shares = i128Positive;

export const registerMerchantBody = z.object({
  address: strkey,
  name,
  barrioId: hex64,
  latE6,
  lngE6,
  category,
});
export type RegisterMerchantBody = z.infer<typeof registerMerchantBody>;

export const mintResidentBody = z.object({
  address: strkey,
  barrioId: hex64,
});
export type MintResidentBody = z.infer<typeof mintResidentBody>;

export const faucetBody = z.object({
  address: strkey,
});
export type FaucetBody = z.infer<typeof faucetBody>;

export const vaultDepositBody = z.object({
  barrioId: hex64,
  amountStroops,
});
export type VaultDepositBody = z.infer<typeof vaultDepositBody>;

export const vaultRedeemBody = z.object({
  barrioId: hex64,
  shares,
});
export type VaultRedeemBody = z.infer<typeof vaultRedeemBody>;

/**
 * Parsea el body o lanza VALIDATION_ERROR (400) con todos los problemas
 * concatenados ("campo: mensaje; campo2: mensaje").
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(body)";
    return `${path}: ${issue.message}`;
  });
  const joined = issues.join("; ");
  throw new RelayerError("VALIDATION_ERROR", `Body inválido: ${joined}`, { issues: joined });
}
