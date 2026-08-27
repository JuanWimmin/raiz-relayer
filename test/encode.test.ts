import { readFileSync } from "node:fs";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { RelayerError } from "../src/errors.js";
import {
  addressToScVal,
  bytes32FromHex,
  bytes32ToScVal,
  i128ToScVal,
  i32ToScVal,
  merchantDataToScVal,
  scValMapKeys,
  stroopsToDecimal,
  symbolToScVal,
} from "../src/stellar/encode.js";

const deployments = JSON.parse(
  readFileSync(new URL("../config/deployments.testnet.json", import.meta.url), "utf8"),
) as { pool: string };

const BARRIO_HEX = "ab".repeat(32);

function expectRelayerCode(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RelayerError);
  expect((err as RelayerError).code).toBe(code);
}

describe("merchantDataToScVal", () => {
  const input = {
    address: Keypair.random().publicKey(),
    name: "Cafe Don Aurelio",
    barrioId: BARRIO_HEX,
    verified: true,
    latE6: 10_421_500,
    lngE6: -75_547_800,
    category: "cafe",
  };

  it("produce un scvMap con las claves en el orden exacto del struct ordenado", () => {
    const scv = merchantDataToScVal(input);
    expect(scv.type).toBe("scvMap");
    expect(scValMapKeys(scv)).toEqual(["address", "barrio_id", "category", "lat_e6", "lng_e6", "name", "verified"]);
  });

  it("codifica cada campo con el tipo que espera el contrato", () => {
    const scv = merchantDataToScVal(input);
    if (scv.type !== "scvMap") throw new Error("no es scvMap");
    const entries = scv.map ?? [];
    const byKey = new Map(entries.map((e) => [e.key.type === "scvSymbol" ? e.key.sym.toString() : "?", e.val]));

    expect(byKey.get("address")?.type).toBe("scvAddress");

    const barrio = byKey.get("barrio_id");
    expect(barrio?.type).toBe("scvBytes");
    if (barrio?.type === "scvBytes") expect(barrio.bytes.toBytes().length).toBe(32);

    const category = byKey.get("category");
    expect(category?.type).toBe("scvSymbol");
    if (category?.type === "scvSymbol") expect(category.sym.toString()).toBe("cafe");

    const lat = byKey.get("lat_e6");
    expect(lat?.type).toBe("scvI32");
    if (lat?.type === "scvI32") expect(lat.i32).toBe(10_421_500);

    const lng = byKey.get("lng_e6");
    expect(lng?.type).toBe("scvI32");
    if (lng?.type === "scvI32") expect(lng.i32).toBe(-75_547_800);

    const name = byKey.get("name");
    expect(name?.type).toBe("scvString");
    if (name?.type === "scvString") expect(name.str.toString()).toBe("Cafe Don Aurelio");

    const verified = byKey.get("verified");
    expect(verified?.type).toBe("scvBool");
    if (verified?.type === "scvBool") expect(verified.b).toBe(true);
  });

  it("acepta un contrato C… como address del comercio", () => {
    const scv = merchantDataToScVal({ ...input, address: deployments.pool });
    expect(scv.type).toBe("scvMap");
  });

  it("rechaza una categoría que no es Symbol válido", () => {
    expectRelayerCode(() => merchantDataToScVal({ ...input, category: "café con espacio" }), "VALIDATION_ERROR");
  });
});

describe("bytes32FromHex", () => {
  it("convierte hex de 64 chars en 32 bytes", () => {
    const b = bytes32FromHex(BARRIO_HEX);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.length).toBe(32);
    expect(b[0]).toBe(0xab);
    expect(bytes32ToScVal(b).type).toBe("scvBytes");
  });

  it("acepta mayúsculas", () => {
    expect(bytes32FromHex("AB".repeat(32)).length).toBe(32);
  });

  it("rechaza longitud inválida", () => {
    expectRelayerCode(() => bytes32FromHex("ab".repeat(31)), "VALIDATION_ERROR");
    expectRelayerCode(() => bytes32FromHex("ab".repeat(33)), "VALIDATION_ERROR");
    expectRelayerCode(() => bytes32FromHex(""), "VALIDATION_ERROR");
  });

  it("rechaza caracteres no hex", () => {
    expectRelayerCode(() => bytes32FromHex("zz".repeat(32)), "VALIDATION_ERROR");
    expectRelayerCode(() => bytes32FromHex(`0x${"ab".repeat(31)}`), "VALIDATION_ERROR");
  });

  it("bytes32ToScVal rechaza arrays que no son de 32 bytes", () => {
    expectRelayerCode(() => bytes32ToScVal(new Uint8Array(31)), "VALIDATION_ERROR");
  });
});

describe("escalares", () => {
  it("i128ToScVal(200000000n) → scvI128", () => {
    const v = i128ToScVal(200_000_000n);
    expect(v.type).toBe("scvI128");
    // Round-trip por XDR para asegurar que es un i128 bien formado.
    const back = xdr.ScVal.fromXdr(v.toXdr("base64"), "base64");
    expect(back.type).toBe("scvI128");
  });

  it("i128ToScVal rechaza fuera de rango", () => {
    expectRelayerCode(() => i128ToScVal(1n << 127n), "VALIDATION_ERROR");
    expectRelayerCode(() => i128ToScVal(-(1n << 127n) - 1n), "VALIDATION_ERROR");
  });

  it("i32ToScVal valida rango y enteros", () => {
    expect(i32ToScVal(-2_147_483_648).type).toBe("scvI32");
    expect(i32ToScVal(2_147_483_647).type).toBe("scvI32");
    expectRelayerCode(() => i32ToScVal(2_147_483_648), "VALIDATION_ERROR");
    expectRelayerCode(() => i32ToScVal(1.5), "VALIDATION_ERROR");
  });

  it("symbolToScVal rechaza símbolos inválidos", () => {
    expect(symbolToScVal("mint_resident").type).toBe("scvSymbol");
    expectRelayerCode(() => symbolToScVal("a".repeat(33)), "VALIDATION_ERROR");
    expectRelayerCode(() => symbolToScVal("con-guion"), "VALIDATION_ERROR");
  });

  it("addressToScVal acepta G… y C… y rechaza basura", () => {
    expect(addressToScVal(Keypair.random().publicKey()).type).toBe("scvAddress");
    expect(addressToScVal(deployments.pool).type).toBe("scvAddress");
    expectRelayerCode(() => addressToScVal("GABC"), "VALIDATION_ERROR");
    expectRelayerCode(() => addressToScVal(Keypair.random().secret()), "VALIDATION_ERROR");
  });
});

describe("stroopsToDecimal", () => {
  it("200000000n → 20.0000000", () => {
    expect(stroopsToDecimal(200_000_000n)).toBe("20.0000000");
  });

  it("1n → 0.0000001", () => {
    expect(stroopsToDecimal(1n)).toBe("0.0000001");
  });

  it("0n → 0.0000000 y montos grandes conservan la parte entera", () => {
    expect(stroopsToDecimal(0n)).toBe("0.0000000");
    expect(stroopsToDecimal(3_412_750_000n)).toBe("341.2750000");
    expect(stroopsToDecimal(10_000_000_000_000_000n)).toBe("1000000000.0000000");
  });

  it("rechaza negativos", () => {
    expectRelayerCode(() => stroopsToDecimal(-1n), "VALIDATION_ERROR");
  });
});
