/**
 * Codificación de argumentos a ScVal para los contratos de RAÍZ.
 *
 * Construimos cada valor a mano (en vez de `nativeToScVal` genérico) para
 * controlar el tipo exacto que espera cada firma Rust: `lat_e6` es i32 (no
 * i64), `category` es Symbol (no String), `barrio_id` es BytesN<32>. Un tipo
 * equivocado no falla aquí: falla en el host con un error opaco de
 * "value conversion", así que la validación temprana es la que da mensajes
 * útiles a la app.
 *
 * Convenciones del monorepo (CLAUDE.md): montos USDC en stroops (i128,
 * 7 decimales), `barrio_id` como hex de 64 chars, lat/lng como i32 × 1e6.
 */
import { Address, StrKey, nativeToScVal, scvSortedMap, xdr } from "@stellar/stellar-sdk";
import { RelayerError } from "../errors.js";

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
/** Símbolos Soroban: [a-zA-Z0-9_], máximo 32 caracteres. */
const SYMBOL_RE = /^[A-Za-z0-9_]{1,32}$/;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

/** 1 USDC = 10_000_000 stroops (7 decimales). */
export const STROOPS_PER_UNIT = 10_000_000n;

export function addressToScVal(addr: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(addr) && !StrKey.isValidContract(addr)) {
    throw new RelayerError("VALIDATION_ERROR", "Dirección Stellar inválida: se espera una cuenta G… o un contrato C….", {
      field: "address",
    });
  }
  return Address.fromString(addr).toScVal();
}

/** hex de 64 chars → 32 bytes (BytesN<32>). */
export function bytes32FromHex(hex64: string): Uint8Array {
  if (typeof hex64 !== "string" || !HEX64_RE.test(hex64)) {
    throw new RelayerError("VALIDATION_ERROR", "barrioId debe ser un hex de 64 caracteres (32 bytes).", {
      field: "barrioId",
    });
  }
  return new Uint8Array(Buffer.from(hex64, "hex"));
}

export function bytes32ToScVal(bytes: Uint8Array): xdr.ScVal {
  if (bytes.length !== 32) {
    throw new RelayerError("VALIDATION_ERROR", `Se esperaban 32 bytes y llegaron ${bytes.length}.`);
  }
  return xdr.ScVal.scvBytes(bytes);
}

export function symbolToScVal(sym: string): xdr.ScVal {
  if (!SYMBOL_RE.test(sym)) {
    throw new RelayerError("VALIDATION_ERROR", "Symbol inválido: solo [a-zA-Z0-9_], máximo 32 caracteres.", {
      field: "symbol",
    });
  }
  return xdr.ScVal.scvSymbol(sym);
}

export function stringToScVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvString(s);
}

export function i32ToScVal(n: number): xdr.ScVal {
  if (!Number.isInteger(n) || n < I32_MIN || n > I32_MAX) {
    throw new RelayerError("VALIDATION_ERROR", "Valor fuera del rango i32.", { value: String(n) });
  }
  return xdr.ScVal.scvI32(n);
}

export function boolToScVal(b: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(b);
}

export function i128ToScVal(v: bigint): xdr.ScVal {
  if (typeof v !== "bigint" || v < I128_MIN || v > I128_MAX) {
    throw new RelayerError("VALIDATION_ERROR", "Valor fuera del rango i128.", { value: String(v) });
  }
  return nativeToScVal(v, { type: "i128" });
}

export interface MerchantDataArgs {
  address: string;
  name: string;
  /** hex de 64 chars. */
  barrioId: string;
  verified: boolean;
  latE6: number;
  lngE6: number;
  category: string;
}

/**
 * `MerchantData` de contracts/pool/src/lib.rs como `scvMap`.
 *
 * Un `#[contracttype] struct` se serializa como mapa con claves Symbol
 * ORDENADAS lexicográficamente; el host rechaza mapas desordenados, por eso
 * pasamos por `scvSortedMap` aunque la lista ya esté en orden.
 */
export function merchantDataToScVal(d: MerchantDataArgs): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return scvSortedMap([
    entry("address", addressToScVal(d.address)),
    entry("barrio_id", bytes32ToScVal(bytes32FromHex(d.barrioId))),
    entry("category", symbolToScVal(d.category)),
    entry("lat_e6", i32ToScVal(d.latE6)),
    entry("lng_e6", i32ToScVal(d.lngE6)),
    entry("name", stringToScVal(d.name)),
    entry("verified", boolToScVal(d.verified)),
  ]);
}

/** Claves (Symbol) de un scvMap en el orden en que están almacenadas. Para tests. */
export function scValMapKeys(scv: xdr.ScVal): string[] {
  if (scv.type !== "scvMap") throw new Error(`scValMapKeys: se esperaba scvMap, llegó ${scv.type}`);
  return (scv.map ?? []).map((e) => {
    const k = e.key;
    if (k.type !== "scvSymbol") throw new Error(`scValMapKeys: clave no-Symbol (${k.type})`);
    return k.sym.toString();
  });
}

/**
 * stroops (bigint) → string decimal con exactamente 7 decimales, que es el
 * formato que `Operation.payment` exige en `amount` ("20.0000000").
 */
export function stroopsToDecimal(stroops: bigint): string {
  if (typeof stroops !== "bigint" || stroops < 0n) {
    throw new RelayerError("VALIDATION_ERROR", "El monto en stroops debe ser un entero no negativo.");
  }
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = stroops % STROOPS_PER_UNIT;
  return `${whole.toString()}.${frac.toString().padStart(7, "0")}`;
}
