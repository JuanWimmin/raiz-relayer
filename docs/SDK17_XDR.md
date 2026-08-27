# Notas: `@stellar/stellar-sdk` 17 en este repo

El SDK 17 reescribió el XDR como **clases generadas** (js-xdr v5). Cambia cómo se
lee y construye todo. Estas notas están verificadas contra los `.d.ts` de
`node_modules/@stellar/stellar-sdk/lib/esm/` (17.0.1). Cuando dudes, abre el
`.d.ts` — no la memoria de versiones anteriores.

## Importación

```ts
import {
  Account, Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation,
  StrKey, TransactionBuilder, Transaction, nativeToScVal, scValToNative,
  scvSortedMap, xdr, rpc, Horizon,
} from "@stellar/stellar-sdk";
```

- ESM-first (`"type": "module"`); este repo usa `moduleResolution: NodeNext` →
  los imports relativos llevan **extensión `.js`** (`./errors.js`).
- HTTP por `fetch` nativo (no axios): en tests, stubear `fetch` o inyectar
  objetos falsos en lugar de `rpc.Server`.
- No hay `@stellar/stellar-base` separado: todo viene del paquete principal.

## XDR: propiedades, no métodos

| Antes (≤15) | Ahora (17) |
|---|---|
| `ev.event().contractId()` | `ev.event.contractId` (`ContractId \| null`) |
| `ev.event().body().v0().topics()` | `ev.event.body.type === "v0"` → `ev.event.body.v0.topics` |
| `scv.switch().name === "scvSymbol"` | `scv.type === "scvSymbol"` |
| `scv.sym().toString()` | `scv.sym.toString()` (`XdrString`) |
| `scv.error().contractCode()` | `scv.type === "scvError"` → `scv.error.type === "sceContract"` → `scv.error.contractCode` |
| `result.result().switch().name` | `result.result.type` (`"txSuccess" \| "txFailed" \| "txBadSeq" \| "txTooLate" \| "txInsufficientFee" …`) |
| `result.result().results()[0].tr().paymentResult().switch().name` | `r = result.result; r.type === "txFailed"` → `r.results[0]` → `.type === "opInner"` → `.tr.type === "payment"` → `.tr.paymentResult.type` (`"paymentNoTrust"` …) |
| `x.toXDR("base64")` | `x.toXdr("base64")` (los objetos XDR); `Transaction.toXDR()` sigue igual |
| `xdr.X.fromXDR(b64, "base64")` | `xdr.X.fromXdr(b64, "base64")` |
| campos opcionales ausentes → `undefined` | → **`null`** (usar `== null`) |
| `Buffer` | **`Uint8Array`** (`Buffer.from(u8).toString("hex")` para hex; `u8.toString()` NO da hex) |

Bytes: `ContractId`, `PublicKey`, etc. extienden `BytesValue` → `.toBytes(): Uint8Array`,
`.value: Uint8Array`. `StrKey.encodeContract(cid.toBytes())` → `C…`.

## Construir ScVal

```ts
Address.fromString("G…|C…").toScVal()                   // scvAddress
xdr.ScVal.scvBytes(bytes32)                             // Uint8Array de 32 → BytesN<32>
xdr.ScVal.scvSymbol("cafe")                             // Symbol
xdr.ScVal.scvString("Cafe Don Aurelio")                 // String
xdr.ScVal.scvBool(true)
xdr.ScVal.scvI32(10421500)
nativeToScVal(200_000_000n, { type: "i128" })           // i128 desde bigint
// Struct (#[contracttype] struct) = scvMap con claves scvSymbol ORDENADAS:
scvSortedMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: Address.fromString(a).toScVal() }),
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("barrio_id"), val: xdr.ScVal.scvBytes(id) }),
  …
])
```

`scvSortedMap` ordena por clave — el host de Soroban **rechaza** mapas desordenados.
`nativeToScVal({...})` también ordena, pero preferimos construir el struct a mano
para controlar el tipo exacto de cada campo (i32 vs i64, symbol vs string).

Leer: `scValToNative(scv)` → nativo. OJO: para `scvString`/`scvSymbol` no UTF-8
devuelve `Uint8Array`, no string.

## Transacciones

```ts
const account = await rpcServer.getAccount(adminPub);          // Account con sequence fresca
const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: Networks.TESTNET })
  .addOperation(new Contract(contractId).call("mint_resident", ...scvals))
  .setTimeout(30)                                              // → tx.timeBounds.maxTime (string unix)
  .build();

const sim = await rpcServer.simulateTransaction(tx);
if (rpc.Api.isSimulationRestore(sim)) { /* RESTORE_REQUIRED */ }
if (rpc.Api.isSimulationError(sim)) { sim.error /* string */; sim.events /* xdr.DiagnosticEvent[] */ }
const prepared = rpc.assembleTransaction(tx, sim).build();     // añade footprint, auth, resource fee
prepared.sign(keypair);
const hashHex = Buffer.from(prepared.hash()).toString("hex");
const sent = await rpcServer.sendTransaction(prepared);
// sent.status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR"
// sent.errorResult?: xdr.TransactionResult (ya parseado) · sent.hash · sent.latestLedgerCloseTime
const got = await rpcServer.getTransaction(hashHex);
// got.status: "SUCCESS" | "NOT_FOUND" | "FAILED" · got.ledger · got.resultXdr (xdr.TransactionResult) · got.latestLedgerCloseTime
```

Clásica (faucet a G…): `Operation.payment({ destination, asset: new Asset("USDC", issuer), amount: "20.0000000" })`
— `amount` es **string decimal** con 7 decimales, no stroops. Sin simulación;
se envía igual por `rpcServer.sendTransaction`.

`rpcServer.getLatestLedger()` → `{ sequence, protocolVersion, closeTime? }`;
`rpcServer.getNetwork()` → `{ passphrase, protocolVersion }`.

Horizon: `new Horizon.Server(url).loadAccount(G…)` → `AccountResponse.balances`
(`asset_type`, `asset_code`, `asset_issuer`, `balance`, `is_authorized`);
cuenta inexistente → lanza `NotFoundError` (exportado del paquete).

## Validación de direcciones

```ts
StrKey.isValidEd25519PublicKey(s)   // G…
StrKey.isValidContract(s)           // C…
StrKey.isValidEd25519SecretSeed(s)  // S…
```

## Errores de contrato en simulación

`sim.error` contiene `"HostError: Error(Contract, #5)"` + un log de eventos
(*newest first*). El número **no identifica el contrato**: Pool #5 =
MerchantNotVerified, Governance #5 = AlreadyResident, yield_adapter #5 =
InsufficientShares. Usa `parseContractError(sim, targetContractId)` de
`src/errors.ts`, que atribuye el código al contrato que falló leyendo
`sim.events`, y luego `mapContractError(role, code, contractId)`.
