import { readFileSync } from "node:fs";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  HTTP_BY_CODE,
  REBUILDABLE_TX_CODES,
  RelayerError,
  mapContractError,
  mapPaymentOpResult,
  parseContractError,
  paymentOpResultName,
  txResultCodeName,
} from "../src/errors.js";

const deployments = JSON.parse(
  readFileSync(new URL("../config/deployments.testnet.json", import.meta.url), "utf8"),
) as { pool: string; governance: string; yield_adapter: string; usdc_sac: string };

const POOL = deployments.pool;
const ADAPTER = deployments.yield_adapter;

// ── helpers XDR (SDK 17: clases generadas, uniones con `.type`) ──────────────

function diagnosticEvent(contractId: string | null, topics: xdr.ScVal[]): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: contractId ? new xdr.ContractId(StrKey.decodeContract(contractId)) : null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data: xdr.ScVal.scvVoid() })),
    }),
  });
}

function contractErrorTopics(code: number): xdr.ScVal[] {
  return [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))];
}

function txResult(result: xdr.TransactionResultResult): xdr.TransactionResult {
  return new xdr.TransactionResult({ feeCharged: 100n, result, ext: xdr.TransactionResultExt.v0() });
}

function paymentOp(r: xdr.PaymentResult): xdr.OperationResult {
  return xdr.OperationResult.opInner(xdr.OperationResultTr.payment(r));
}

// ── RelayerError ─────────────────────────────────────────────────────────────

describe("RelayerError", () => {
  it("deriva http y retryable del código y serializa el envelope", () => {
    const e = new RelayerError("QUEUE_FULL", "lleno", { pending: 20 });
    expect(e.http).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.toBody()).toEqual({
      ok: false,
      error: { code: "QUEUE_FULL", message: "lleno", retryable: true, details: { pending: 20 } },
    });
    const v = new RelayerError("VALIDATION_ERROR", "mal");
    expect(v.retryable).toBe(false);
    expect(v.toBody()).toEqual({ ok: false, error: { code: "VALIDATION_ERROR", message: "mal", retryable: false } });
  });

  it("todos los códigos tienen HTTP status", () => {
    for (const [code, status] of Object.entries(HTTP_BY_CODE)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
    }
  });
});

// ── mapContractError: el mismo número significa cosas distintas por contrato ─

describe("mapContractError", () => {
  it("governance #5 → ALREADY_RESIDENT (409)", () => {
    const e = mapContractError("governance", 5, deployments.governance);
    expect(e.code).toBe("ALREADY_RESIDENT");
    expect(e.http).toBe(409);
    expect(e.details).toMatchObject({ contract: "governance", contractCode: 5, name: "AlreadyResident", contractId: deployments.governance });
  });

  it("yield_adapter #5 → CONTRACT_ERROR con name InsufficientShares", () => {
    const e = mapContractError("yield_adapter", 5, ADAPTER);
    expect(e.code).toBe("CONTRACT_ERROR");
    expect(e.http).toBe(422);
    expect(e.details).toMatchObject({ contract: "yield_adapter", contractCode: 5, name: "InsufficientShares" });
  });

  it("pool #6 → BARRIO_NOT_FOUND (404)", () => {
    const e = mapContractError("pool", 6, POOL);
    expect(e.code).toBe("BARRIO_NOT_FOUND");
    expect(e.http).toBe(404);
    expect(e.details?.name).toBe("BarrioNotFound");
  });

  it("pool #3 y governance #3 → UNAUTHORIZED_ADMIN (502): relayer mal configurado", () => {
    expect(mapContractError("pool", 3).code).toBe("UNAUTHORIZED_ADMIN");
    expect(mapContractError("pool", 3).http).toBe(502);
    expect(mapContractError("governance", 3).code).toBe("UNAUTHORIZED_ADMIN");
  });

  it("usdc_sac #13 → NO_TRUSTLINE (422)", () => {
    const e = mapContractError("usdc_sac", 13, deployments.usdc_sac);
    expect(e.code).toBe("NO_TRUSTLINE");
    expect(e.http).toBe(422);
    expect(e.details?.name).toBe("TrustlineMissingError");
  });

  it("usdc_sac #10 → FAUCET_EMPTY (503)", () => {
    const e = mapContractError("usdc_sac", 10, deployments.usdc_sac);
    expect(e.code).toBe("FAUCET_EMPTY");
    expect(e.http).toBe(503);
  });

  it("usdc_sac #11 → TRUSTLINE_DEAUTHORIZED y #6 → ACCOUNT_NOT_FOUND", () => {
    expect(mapContractError("usdc_sac", 11).code).toBe("TRUSTLINE_DEAUTHORIZED");
    expect(mapContractError("usdc_sac", 6).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("código desconocido o contrato sin tabla → CONTRACT_ERROR genérico con contractCode", () => {
    const e = mapContractError("pool", 99, POOL);
    expect(e.code).toBe("CONTRACT_ERROR");
    expect(e.details).toMatchObject({ contract: "pool", contractCode: 99 });
    expect(e.details?.name).toBeUndefined();

    const b = mapContractError("blend_pool", 12);
    expect(b.code).toBe("CONTRACT_ERROR");
    expect(b.details).toMatchObject({ contract: "blend_pool", contractCode: 12 });

    const u = mapContractError("unknown", 5, POOL);
    expect(u.code).toBe("CONTRACT_ERROR");
    expect(u.details).toMatchObject({ contract: "unknown", contractCode: 5, contractId: POOL });
  });
});

// ── parseContractError: atribución del código al contrato que falló ─────────

describe("parseContractError", () => {
  const ERR5 = "HostError: Error(Contract, #5)\n\nEvent log (newest first):\n";

  it("sin Error(Contract, #N) en el texto → undefined", () => {
    expect(parseContractError({ error: "HostError: Error(Auth, InvalidAction)", events: [] }, POOL)).toBeUndefined();
  });

  it("eventos XDR: atribuye al contrato cuyo evento 'error' lleva el mismo código (aunque no sea el target)", () => {
    // Primero un evento sin código (fn_call del Pool), luego el error del adapter.
    const events = [
      diagnosticEvent(POOL, [xdr.ScVal.scvSymbol("fn_call"), xdr.ScVal.scvSymbol("deposit")]),
      diagnosticEvent(ADAPTER, contractErrorTopics(5)),
    ];
    const r = parseContractError({ error: ERR5, events }, POOL);
    expect(r).toEqual({ code: 5, contractId: ADAPTER });
  });

  it("eventos XDR: el primer evento 'error' con el código gana (frame más interno), no el del target", () => {
    const events = [
      diagnosticEvent(ADAPTER, contractErrorTopics(5)),
      diagnosticEvent(POOL, contractErrorTopics(5)), // el Pool re-propaga el mismo error
    ];
    const r = parseContractError({ error: ERR5, events }, POOL);
    expect(r?.contractId).toBe(ADAPTER);
  });

  it("eventos XDR: un evento 'error' sin contractId no cuenta; cae al siguiente con contractId", () => {
    const events = [
      diagnosticEvent(null, contractErrorTopics(5)),
      diagnosticEvent(ADAPTER, [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvString("otro")]),
    ];
    const r = parseContractError({ error: ERR5, events }, POOL);
    expect(r?.contractId).toBe(ADAPTER);
  });

  it("fallback por texto: elige el ÚLTIMO contract:C… del log (newest first → el más interno)", () => {
    const text =
      `${ERR5}0: [Diagnostic Event] contract:${POOL}, topics:[error, Error(Contract, #5)], data:"escalating error"\n` +
      `1: [Diagnostic Event] contract:${ADAPTER}, topics:[error, Error(Contract, #5)], data:"insufficient shares"`;
    expect(parseContractError({ error: text, events: [] }, POOL)).toEqual({ code: 5, contractId: ADAPTER });
    expect(parseContractError({ error: text }, POOL)?.contractId).toBe(ADAPTER);
  });

  it("fallback al target cuando no hay eventos ni contract:C… en el texto", () => {
    expect(parseContractError({ error: "HostError: Error(Contract, #5)", events: [] }, deployments.governance)).toEqual({
      code: 5,
      contractId: deployments.governance,
    });
  });

  it("los eventos tienen prioridad sobre el texto", () => {
    const text = `${ERR5}0: [Diagnostic Event] contract:${POOL}, topics:[error, Error(Contract, #5)]`;
    const events = [diagnosticEvent(ADAPTER, contractErrorTopics(5))];
    expect(parseContractError({ error: text, events }, POOL)?.contractId).toBe(ADAPTER);
  });
});

// ── Resultados de transacción ────────────────────────────────────────────────

describe("txResultCodeName / paymentOpResultName", () => {
  it("txResultCodeName lee el discriminante del resultado", () => {
    expect(txResultCodeName(txResult(xdr.TransactionResultResult.txBadSeq()))).toBe("txBadSeq");
    expect(txResultCodeName(txResult(xdr.TransactionResultResult.txTooLate()))).toBe("txTooLate");
    expect(txResultCodeName(txResult(xdr.TransactionResultResult.txInsufficientFee()))).toBe("txInsufficientFee");
    expect(txResultCodeName(txResult(xdr.TransactionResultResult.txSuccess([])))).toBe("txSuccess");
    expect(txResultCodeName(txResult(xdr.TransactionResultResult.txFailed([]))))
      .toBe("txFailed");
  });

  it("REBUILDABLE_TX_CODES contiene exactamente los tres códigos de reconstrucción", () => {
    expect([...REBUILDABLE_TX_CODES].sort()).toEqual(["txBadSeq", "txInsufficientFee", "txTooLate"]);
  });

  it("paymentOpResultName extrae el resultado de la op payment", () => {
    const noTrust = txResult(xdr.TransactionResultResult.txFailed([paymentOp(xdr.PaymentResult.paymentNoTrust())]));
    expect(paymentOpResultName(noTrust)).toBe("paymentNoTrust");

    const underfunded = txResult(
      xdr.TransactionResultResult.txFailed([paymentOp(xdr.PaymentResult.paymentUnderfunded())]),
    );
    expect(paymentOpResultName(underfunded)).toBe("paymentUnderfunded");
  });

  it("paymentOpResultName devuelve el resultado de op si no llegó a ejecutarse", () => {
    const noAccount = txResult(xdr.TransactionResultResult.txFailed([xdr.OperationResult.opNoAccount()]));
    expect(paymentOpResultName(noAccount)).toBe("opNoAccount");
  });

  it("paymentOpResultName → undefined si no es txFailed/txSuccess o no hay ops", () => {
    expect(paymentOpResultName(txResult(xdr.TransactionResultResult.txBadSeq()))).toBeUndefined();
    expect(paymentOpResultName(txResult(xdr.TransactionResultResult.txFailed([])))).toBeUndefined();
  });

  it("round-trip XDR base64 conserva el resultado (como llega del RPC)", () => {
    const original = txResult(xdr.TransactionResultResult.txFailed([paymentOp(xdr.PaymentResult.paymentNoTrust())]));
    const back = xdr.TransactionResult.fromXdr(original.toXdr("base64"), "base64");
    expect(txResultCodeName(back)).toBe("txFailed");
    expect(paymentOpResultName(back)).toBe("paymentNoTrust");
  });
});

describe("mapPaymentOpResult", () => {
  it("mapea los resultados relevantes del faucet", () => {
    expect(mapPaymentOpResult("paymentNoTrust").code).toBe("NO_TRUSTLINE");
    expect(mapPaymentOpResult("paymentUnderfunded").code).toBe("FAUCET_EMPTY");
    expect(mapPaymentOpResult("paymentNoDestination").code).toBe("ACCOUNT_NOT_FOUND");
    expect(mapPaymentOpResult("opNoAccount").code).toBe("ACCOUNT_NOT_FOUND");
    expect(mapPaymentOpResult("paymentNotAuthorized").code).toBe("TRUSTLINE_DEAUTHORIZED");
  });

  it("otros → TX_FAILED con details.opResult y txResult", () => {
    const e = mapPaymentOpResult("paymentLineFull", "txFailed");
    expect(e.code).toBe("TX_FAILED");
    expect(e.http).toBe(502);
    expect(e.details).toEqual({ opResult: "paymentLineFull", txResult: "txFailed" });
  });
});
