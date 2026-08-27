# raiz-relayer — Admin Relayer de RAÍZ (Stellar testnet)

Servicio HTTP open-source que **firma server-side los flujos admin** de
[RAÍZ](https://github.com/JuanWimmin) — registro de comercios, soulbound de residentes, faucet de
USDC y movimientos del vault — para que el **APK release ya no lleve la clave admin**.

Es el entregable **D1 "Admin Relayer"** del SOW con Instaward. Solo funciona contra **testnet** y
se niega a arrancar con cualquier otra red.

> **Sucesor previsto:** este relayer es un puente pragmático. En la fase **F3 (custodia comunal)**
> del roadmap la autoridad admin pasa a un esquema multisig/comunitario y este servicio deja de ser
> necesario. Nada de lo que hay aquí pretende ser seguridad de mainnet (ver
> [Modelo de amenazas](#modelo-de-amenazas-testnet-honesto)).

---

## Por qué existe

Hasta la v0.1 de la app, los flujos que exigen `admin.require_auth()` en los contratos
(`Pool.register_merchant`, `Governance.mint_resident`, el faucet de USDC y
`Pool.deposit_idle_to_vault / redeem_from_vault`) se firmaban **dentro del APK** con
`DEMO_ADMIN_SECRET`. Cualquiera que descompilara el APK obtenía la clave admin del protocolo.

Con el relayer:

- la clave admin vive **solo** en la variable de entorno `RELAYER_ADMIN_SECRET` del servidor;
- la app llama a un endpoint JSON con una API key estática y recibe el `txHash`;
- el APK release se verifica sin secretos (`grep -rE "S[A-Z0-9]{55}"` = 0).

## Arquitectura en 10 líneas

1. **Node 22 + TypeScript ESM**, **Fastify 5**, **`@stellar/stellar-sdk` 17** (RPC + Horizon), zod, pino.
2. `GET /v1/health` público; los `POST` exigen el header `x-raiz-app-key` (comparación en tiempo constante).
3. Validación zod estricta de bodies (≤ 8 KB) → **preflights** (existencia de cuenta, trustline, `get_merchant`, balance del admin).
4. **Rate-limits en memoria**: por IP (60/min), por address (faucet 1/10 min) y cupos diarios UTC por endpoint.
5. **Cola serializada** (`SerialQueue`): una transacción a la vez porque hay **una** cuenta admin = **un** sequence number.
6. Pipeline único `submit()`: simulate → assemble → sign → send → poll, con deadline de 75 s, reintentos ante propagación RPC y **política anti doble gasto** (máx. 1 rebuild, solo si la tx anterior es `NOT_FOUND` y su `maxTime` venció).
7. **Allowlist de 6 contratos** (`pool, governance, treasury, rewards, yield_adapter, usdc_sac` de `config/deployments.testnet.json`); cualquier otro `contractId` se rechaza.
8. Errores de contrato **atribuidos al contrato que falló** (eventos de diagnóstico), porque los códigos numéricos colisionan entre Pool, Governance, adapter y SAC.
9. `idempotency-key` opcional → misma respuesta durante 10 min; peticiones concurrentes comparten la promesa.
10. Logs pino con `redact` (secret, `x-raiz-app-key`, `authorization`); `sim.error` crudo solo en `debug`.

---

## Endpoints

Base: `/v1`. Todos JSON (`content-type: application/json`), body ≤ 8 KB.

**Auth:** header `x-raiz-app-key: <RELAYER_APP_KEY>` en todos los POST (401 si falta o no coincide).
`GET /v1/health` es público (pero está bajo el limitador por IP).

**Idempotencia (opcional):** header `idempotency-key` (≤ 64 chars) → la misma respuesta durante
10 min; misma key con body distinto → `422 IDEMPOTENCY_MISMATCH`; peticiones concurrentes con la
misma key esperan la misma promesa (no se firma dos veces).

### Envelope

```jsonc
// éxito
{ "ok": true, "txHash": "<hex64>", "ledger": 4365434, ...extras }
// error (nunca se devuelve el sim.error crudo)
{ "ok": false, "error": { "code": "…", "message": "…(español)", "retryable": false, "details": { … } } }
```

### HTTP ↔ `error.code`

| HTTP | `error.code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body inválido (`details` con el campo) |
| 401 | `UNAUTHORIZED_APP` | falta/incorrecta `x-raiz-app-key` |
| 404 | `BARRIO_NOT_FOUND` | Pool #6 |
| 404 | `BARRIO_ADMIN_NOT_SET` | Governance #4 |
| 404 | `ACCOUNT_NOT_FOUND` | faucet a G… sin crear (Horizon 404 / SAC #6) → "usa friendbot primero" |
| 404 | `NOT_FOUND` | ruta inexistente (o `/v1/vault/*` con `VAULT_ENDPOINTS_ENABLED=false`) |
| 409 | `ALREADY_RESIDENT` | Governance #5 |
| 409 | `MERCHANT_EXISTS` | preflight `get_merchant`: ya registrado, no se sobrescribe |
| 413 | `PAYLOAD_TOO_LARGE` | body > 8 KB |
| 422 | `NO_TRUSTLINE` | G… sin trustline USDC (preflight Horizon / `op_no_trust` / SAC #13) |
| 422 | `TRUSTLINE_DEAUTHORIZED` | SAC #11 |
| 422 | `IDEMPOTENCY_MISMATCH` | misma `idempotency-key`, body distinto |
| 422 | `CONTRACT_ERROR` | otro error de contrato; `details.contract`, `details.contractCode`, `details.name?` |
| 429 | `RATE_LIMITED` | `details.retryAfterSeconds` + header **`Retry-After`** |
| 502 | `UNAUTHORIZED_ADMIN` | #3 en Pool/Governance/adapter: el relayer no es admin (mal configurado) |
| 502 | `TX_FAILED` | tx aplicada con fallo; `details.txResult` |
| 503 | `FAUCET_EMPTY` | balance USDC del admin < monto → [runbook](#runbook-re-fondear-el-faucet) |
| 503 | `RPC_UNREACHABLE` | RPC/Horizon caídos |
| 503 | `QUEUE_FULL` | cola > `QUEUE_CAP` (20) |
| 503 | `RESTORE_REQUIRED` | TTL vencido en entradas de Blend (vault) |
| 503 | `TX_TIMEOUT` | deadline vencido con tx en vuelo; `details.txHash` — **puede aplicarse después** |
| 500 | `INTERNAL` | error no clasificado |

`retryable: true` solo en `RATE_LIMITED`, `RPC_UNREACHABLE`, `QUEUE_FULL`, `TX_TIMEOUT`, `RESTORE_REQUIRED`.

### `GET /v1/health` (público, cache 10 s)

```jsonc
200 { "ok": true, "network": "testnet", "protocolVersion": 28, "admin": "GBLS7PL5…",
      "contracts": { "pool": "…", "governance": "…", "treasury": "…", "rewards": "…", "yield_adapter": "…", "usdc_sac": "…" },
      "faucet": { "enabled": true, "amountStroops": "200000000", "adminUsdcStroops": "3412750000", "remainingToday": 50 },
      "limits": { "faucetPerAddressMinutes": 10, "faucetDaily": 50, "registerDaily": 20, "mintDaily": 20, "vaultDaily": 20 },
      "vaultEndpoints": true, "queue": { "pending": 0 }, "version": "0.1.0", "uptimeSeconds": 123 }
503 { "ok": false, "error": { "code": "RPC_UNREACHABLE", … } }
```

La app usa `ok` como feature-flag del relayer y `faucet.enabled` / `vaultEndpoints` para mostrar u ocultar botones.

### `POST /v1/register-merchant` → `Pool.register_merchant(MerchantData)`

```jsonc
req  { "address": "G…|C…", "name": "Cafe Don Aurelio" /* 2..40 */, "barrioId": "<hex64>",
       "latE6": 10421500 /* [-90e6, 90e6] */, "lngE6": -75547800 /* [-180e6, 180e6] */,
       "category": "cafe|restaurante|artesania|tienda|cultura|hospedaje|otro" }
200  { "ok": true, "txHash": "…", "ledger": n, "merchant": { "address": "…", "barrioId": "…" } }
409  MERCHANT_EXISTS · 404 BARRIO_NOT_FOUND · 502 UNAUTHORIZED_ADMIN · 429 RATE_LIMITED
```

`verified = true` se fija server-side (como hacía la app). El contrato sobrescribe sin comprobar
existencia, por eso el preflight `get_merchant` devuelve `409` (re-registrar = intervención manual
del admin). Cupo: 20/día.

### `POST /v1/mint-resident` → `Governance.mint_resident(barrio_admin, resident, barrio_id)`

```jsonc
req  { "address": "G…|C…", "barrioId": "<hex64>" }
200  { "ok": true, "txHash": "…", "ledger": n }
409  ALREADY_RESIDENT · 404 BARRIO_ADMIN_NOT_SET · 502 UNAUTHORIZED_ADMIN · 429 RATE_LIMITED
```

El relayer firma como `barrio_admin = GBLS7PL5…` (el seed configura esa cuenta como admin de los 3
barrios). Soulbound: nunca hay `transfer`. Cupo: 20/día.

### `POST /v1/faucet` → 20 USDC de Blend (`FAUCET_AMOUNT_STROOPS`)

```jsonc
req  { "address": "G…|C…" }
200  { "ok": true, "txHash": "…", "ledger": n, "amountStroops": "200000000",
       "asset": "USDC:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56", "method": "payment|sac_transfer" }
404  ACCOUNT_NOT_FOUND · 422 NO_TRUSTLINE · 422 TRUSTLINE_DEAUTHORIZED · 503 FAUCET_EMPTY · 429 RATE_LIMITED
```

- `G…` → op **`payment` clásica** (aparece en Horizon `/payments`, que es lo que lee el historial de la app).
- `C…` → **SAC `transfer(admin, C…, i128)`** sobre `usdc_sac`.

Cupo: 1 por address cada 10 min · 50/día global.

### `POST /v1/vault/deposit` y `POST /v1/vault/redeem` (extensión fuera del SOW)

Necesarios para la pantalla Yield (`YieldViewModel`), que también firmaba como admin.
`VAULT_ENDPOINTS_ENABLED=true` por defecto; con `false` responden `404 NOT_FOUND`.

```jsonc
deposit req { "barrioId": "<hex64>", "amountStroops": "20000000" }  → Pool.deposit_idle_to_vault(admin, barrio_id, amount)
redeem  req { "barrioId": "<hex64>", "shares": "12345" }            → Pool.redeem_from_vault(admin, barrio_id, shares)
200 { "ok": true, "txHash": "…", "ledger": n }
422 CONTRACT_ERROR  // details.contract ∈ { pool, yield_adapter, blend_pool }; details.name ∈
                    //   pool: INSUFFICIENT_LIQUIDITY(#10) | ADAPTER_NOT_CONFIGURED(#9) | INVALID_AMOUNT(#7) | INVALID_BPS(#12)
                    //   yield_adapter: INVALID_AMOUNT(#4) | INSUFFICIENT_SHARES(#5) | UNAUTHORIZED(#3)
                    //   blend_pool: código crudo
404 BARRIO_NOT_FOUND · 503 RESTORE_REQUIRED
```

Montos como **string decimal** (i128, stroops con 7 decimales). Solo mueven fondos Pool ↔ adapter
(sin pérdida posible). Cupo: 20/día.

---

## Variables de entorno

Copia `.env.example` a `.env`. Obligatorias:

| Variable | Significado |
|---|---|
| `NETWORK` | Debe ser exactamente `testnet`. Cualquier otro valor → el proceso no arranca. |
| `RELAYER_ADMIN_SECRET` | Clave `S…` del admin del protocolo. **Debe derivar a `deployments.admin`** (`GBLS7PL5…`) o el proceso no arranca. Nunca al repo ni a logs. |
| `RELAYER_APP_KEY` | API key estática que envía la app en `x-raiz-app-key` (≥ 16 chars). `openssl rand -hex 24`. |

Opcionales (default entre paréntesis):

| Variable | Default | Significado |
|---|---|---|
| `RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon (preflights de cuenta/trustline/balance) |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Escucha HTTP |
| `FAUCET_AMOUNT_STROOPS` | `200000000` | Monto del faucet (20 USDC, 7 decimales) |
| `RATE_FAUCET_PER_ADDRESS_MINUTES` | `10` | Ventana por address del faucet |
| `RATE_FAUCET_DAILY` | `50` | Cupo diario global del faucet |
| `RATE_REGISTER_DAILY` | `20` | Cupo diario de `register-merchant` |
| `RATE_MINT_DAILY` | `20` | Cupo diario de `mint-resident` |
| `RATE_VAULT_DAILY` | `20` | Cupo diario conjunto de `vault/*` |
| `RATE_PER_IP_PER_MINUTE` | `60` | Limitador por IP (`trustProxy` para el `X-Forwarded-For` de Fly) |
| `VAULT_ENDPOINTS_ENABLED` | `true` | `false` → `/v1/vault/*` responde 404 |
| `LOG_LEVEL` | `info` | pino (`fatal…trace`, `silent`) |
| `DEPLOYMENTS_FILE` | `config/deployments.testnet.json` | Copia literal del `deployments.json` del monorepo |
| `QUEUE_CAP` | `20` | Jobs en espera antes de `503 QUEUE_FULL` |
| `JOB_DEADLINE_MS` | `75000` | Deadline del pipeline por job (debe ser < `JOB_TIMEOUT_MS`) |
| `JOB_TIMEOUT_MS` | `90000` | Timeout duro del job |
| `SUBMIT_ATTEMPTS` | `5` | Reintentos de `sendTransaction` ante `TRY_AGAIN_LATER` / red |
| `SUBMIT_BACKOFF_MS` | `3000` | Espera entre reintentos |
| `TX_TIMEOUT_SECONDS` | `30` | `maxTime` de la transacción |
| `IDEMPOTENCY_TTL_MS` | `600000` | Vida de la caché de `idempotency-key` (10 min) |
| `HEALTH_CACHE_MS` | `10000` | Caché de `/v1/health` |

---

## Setup local

Requisitos: Node **22** (`.nvmrc`), npm, [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
con la identidad `raiz-admin` (la misma del monorepo).

```bash
git clone https://github.com/JuanWimmin/raiz-relayer && cd raiz-relayer
npm ci
cp .env.example .env
# Edita .env: RELAYER_APP_KEY=$(openssl rand -hex 24) y el secret desde la CLI (no lo pegues a mano):
export RELAYER_ADMIN_SECRET=$(stellar keys show raiz-admin)
npm run dev                # tsx watch src/index.ts
curl -s http://localhost:8080/v1/health | jq .
```

Prueba de humo de todos los endpoints contra un relayer vivo:

```bash
RELAYER_APP_KEY=… ./scripts/smoke.sh                      # local
RELAYER_URL=https://raiz-relayer.fly.dev RELAYER_APP_KEY=… ./scripts/smoke.sh
```

## Tests

```bash
npm run typecheck   # tsc sobre src/ y test/
npm test            # vitest: rate-limit, cola, idempotencia, encode ScVal, errores, submit (RPC falso), rutas (fastify.inject)
```

Integración real contra testnet (firma transacciones de verdad y consume cupos):

```bash
export RELAYER_ADMIN_SECRET=$(stellar keys show raiz-admin)
export RELAYER_APP_KEY=cualquier-cosa-de-16-chars
RELAYER_IT=1 npm run test:it
```

Necesita: red hacia `soroban-testnet.stellar.org` y `horizon-testnet.stellar.org`, el admin con
XLM y ≥ 40 USDC de Blend (ver runbook), y `config/deployments.testnet.json` igual al deploy vigente.
Timeout por test: 180 s.

---

## Docker y Fly.io

```bash
docker build -t raiz-relayer .
docker run --rm -p 8080:8080 -e NETWORK=testnet \
  -e RELAYER_ADMIN_SECRET="$(stellar keys show raiz-admin)" \
  -e RELAYER_APP_KEY="$RELAYER_APP_KEY" raiz-relayer
```

Fly.io (región `bog`, `fly.toml` incluido):

```bash
fly launch --no-deploy            # usa el fly.toml existente; no crees Postgres ni Redis
fly secrets set NETWORK=testnet \
  RELAYER_ADMIN_SECRET="$(stellar keys show raiz-admin)" \
  RELAYER_APP_KEY="$(openssl rand -hex 24)"
fly deploy --ha=false             # ← SIEMPRE con --ha=false
```

**Por qué una sola máquina:** el relayer mantiene **una cola serializada por clave admin**. Hay una
única cuenta admin y, por tanto, un único sequence number en la red. Con dos máquinas cada una
lleva su propia cola y se pisan la secuencia: `txBadSeq` intermitentes, reintentos que no arreglan
nada y cupos diarios duplicados (los contadores son por proceso). `fly deploy` sin `--ha=false`
crea dos máquinas por defecto. `fly.toml` fija `min_machines_running = 1`,
`auto_stop_machines = "off"` y `kill_timeout = 120` para que el `SIGTERM` pueda drenar la cola.

---

## Límites y cupos

| Recurso | Límite | Ámbito |
|---|---|---|
| Cualquier ruta | 60 req/min | por IP (`X-Forwarded-For` de Fly) |
| `POST /v1/faucet` | 1 cada 10 min | por `address` |
| `POST /v1/faucet` | 50/día (UTC) | global |
| `POST /v1/register-merchant` | 20/día (UTC) | global |
| `POST /v1/mint-resident` | 20/día (UTC) | global |
| `POST /v1/vault/*` | 20/día (UTC) conjunto | global |
| Cola | 20 jobs en espera | global (`503 QUEUE_FULL`) |
| Body | 8 KB | por request |

Aclaraciones:

- El SOW dice "20/día global" para register/mint; se implementa como **20 por endpoint**
  (contadores independientes), que es la lectura más útil operativamente.
- Los contadores viven **en memoria**: se reinician con cada redeploy/reinicio (y el día cambia a
  las 00:00 UTC). No hay persistencia a propósito (testnet, una máquina).
- El cupo se **consume después de la validación y los preflights, y antes del envío**: un `400`,
  `404`, `409` o `422` no quema cupo; un `TX_TIMEOUT` sí (la tx puede aplicarse después y no
  debe poder repetirse gratis).

---

## Modelo de amenazas (testnet, honesto)

Este servicio protege **una cosa**: que la clave admin no viaje en el APK. Todo lo demás son
mitigaciones de abuso, no autenticación.

- **La API key viaja en el APK y es extraíble.** `x-raiz-app-key` limita el abuso casual
  (bots, curiosos) y permite rotarla; **no autentica** a nadie. Cualquiera que descompile el APK
  tiene la key.
- **No hay prueba de propiedad del `address`.** Quien tenga la key puede pedir `mint-resident`
  o `register-merchant` para **cualquier dirección**, o el faucet hacia cualquier cuenta.
  Mitigaciones: `ALREADY_RESIDENT` (un soulbound por address, nunca se re-mintea),
  `MERCHANT_EXISTS` (no se sobrescribe un comercio), cupos diarios, ventana por address del
  faucet y allowlist de contratos. **Lo que NO cubre:** que un tercero registre como comercio o
  residente una dirección ajena antes que su dueño, o vacíe el cupo diario de faucet/mint a
  propósito (denegación de servicio barata). En testnet el impacto es demo rota, no dinero.
- **La clave admin solo está en env** (`RELAYER_ADMIN_SECRET`); el proceso verifica que deriva a
  `deployments.admin`; pino redacta secret y headers; el `sim.error` crudo solo en `debug`.
- **Sin CORS**: no se emiten cabeceras `Access-Control-*`, así que los navegadores bloquean el
  uso desde webs de terceros. La app nativa no necesita CORS.
- **Allowlist de 6 contratos** (los 5 de RAÍZ + el SAC de USDC que exige el faucet; el SOW
  decía "5", la desviación es esta): `submit()` rechaza cualquier otro `contractId`.
- **Anti doble gasto** en el pipeline: reenviar el mismo envelope siempre es seguro; solo se
  reconstruye con secuencia nueva si la tx anterior es `NOT_FOUND` y su `maxTime` venció.
- **Nada de esto es seguridad de mainnet.** No hay firma del usuario, ni KYC, ni límites por
  identidad. El sucesor es la custodia comunal (F3) y la firma por parte del propio usuario.

### Rotación de `RELAYER_APP_KEY`

```bash
fly secrets set RELAYER_APP_KEY="$(openssl rand -hex 24)"   # Fly reinicia la máquina
```

Después hay que publicar un **nuevo APK** con la key nueva (`local.properties` →
`BuildConfig.RELAYER_APP_KEY`). Las versiones antiguas reciben `401 UNAUTHORIZED_APP`.

---

## Runbook: re-fondear el faucet

**Síntoma:** `POST /v1/faucet` responde `503 FAUCET_EMPTY`, o `GET /v1/health` muestra
`faucet.enabled = false` / `adminUsdcStroops` bajo. El admin (`GBLS7PL5Y65DHQIPMJO6HVQLX4FXEEHQDWHGSBUTGT4V6ZV2IOACYC2P`)
se ha quedado sin USDC de Blend (issuer `GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56`,
SAC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`). El admin **no puede acuñarlo**: hay
que pedirlo al faucet público de Blend (~1 000 USDC por cuenta), que devuelve un XDR ya construido
que se firma con la clave de la cuenta y se envía.

**El faucet de Blend sirve UNA sola vez por cuenta** (verificado el 2026-08-27: para el admin, que ya
reclamó, devuelve un envelope sin operaciones que el CLI rechaza con "failed to decode XDR"). Por eso
el procedimiento es: identidad donante nueva → faucet → pago clásico de 1 000 USDC al admin.
Con Stellar CLI (≥ 23) y la identidad `raiz-admin` ya configurada:

```bash
NETWORK=testnet
ADMIN=$(stellar keys address raiz-admin)         # → GBLS7PL5…
USDC_ISSUER=GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56
DONOR=raiz-faucet-donor-$(date +%s)               # identidad temporal, una por re-fondeo

# 1. Donante nuevo con XLM (friendbot)
stellar keys generate "$DONOR" --fund --network "$NETWORK"
DONOR_ADDR=$(stellar keys address "$DONOR")

# 2. Reclamar el faucet de Blend con el donante (trustlines + ~1 000 USDC)
XDR=$(curl -s "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets?userId=$DONOR_ADDR" | tr -d '"')
[[ "$XDR" == AAAA* && ${#XDR} -gt 500 ]] || { echo "faucet: respuesta inesperada (${#XDR} chars)"; exit 1; }
printf '%s' "$XDR" | stellar tx sign --sign-with-key "$DONOR" --network "$NETWORK"     | stellar tx send --network "$NETWORK"

# 3. Pagar los 1 000 USDC al admin (monto en stroops: 1 000 × 10^7)
stellar tx new payment --source "$DONOR" --network "$NETWORK"     --destination "$ADMIN" --asset "USDC:$USDC_ISSUER" --amount 10000000000
```

Repite con otro donante si hace falta más (objetivo: ≥ 1 000 USDC ≈ 50 faucets de 20). La
respuesta del faucet puede tardar o fallar por rate-limit: reintenta pasados unos segundos.

Verificación:

```bash
curl -s "https://horizon-testnet.stellar.org/accounts/$ADDR" \
  | jq '.balances[] | select(.asset_code=="USDC" and .asset_issuer=="GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56") | .balance'
curl -s https://raiz-relayer.fly.dev/v1/health | jq .faucet     # enabled=true, adminUsdcStroops actualizado (cache 10 s)
```

Si el admin también anda corto de XLM (fees), `stellar keys fund raiz-admin --network testnet`
(friendbot) o cualquier faucet de XLM de testnet.

---

## Verificación por un revisor

Sin credenciales:

```bash
curl -s https://raiz-relayer.fly.dev/v1/health | jq .
```

Debe devolver `ok: true`, `network: "testnet"`, `admin: "GBLS7PL5…"` y los contratos iguales a
`config/deployments.testnet.json` (= `deployments.json` del monorepo).

Con la API key (la del APK o una que te pase el equipo), un `POST` devuelve un `txHash`; se
comprueba on-chain en Stellar Expert:

```
https://stellar.expert/explorer/testnet/tx/<txHash>
```

Allí se ve el firmante (`GBLS7PL5…`), la operación (`invokeHostFunction` o `payment`) y el
contrato invocado. Los hashes de la sesión de evidencia están archivados en el monorepo,
`docs/evidencia_sow/d1/`.

Verificación de "cero secretos" en el APK release (comando literal del plan del SOW):

```bash
apktool d app-release.apk && grep -rE "S[A-Z0-9]{55}" app-release/   # → 0 matches
grep -r "GBLS7PL5Y65DHQIPMJO6HVQLX4FXEEHQDWHGSBUTGT4V6ZV2IOACYC2P" app-release/  # solo en assets/deployments.json
```

Y en este repo: `git grep -E "S[A-Z0-9]{55}"` → 0 resultados.

---

## Relación con el SOW y la sesión B

- **D1 "Admin Relayer"** (SOW Instaward, WP1): este repo es el servicio. La aceptación de D1
  exige además que la app llame al relayer y que el APK no contenga secretos — eso es la
  **sesión B** (migración de la app Android). Las notas para esa migración (mapeo de códigos a
  `RaizErrorCode`, timeouts, idempotencia, health como feature-flag, faucet a G… vs C…, vault)
  están en [`docs/SESION_B_APP.md`](docs/SESION_B_APP.md).
- Decisiones de arquitectura: `Protocolo_Raiz/docs/PLAN_CLAUDE_CODE_SOW.md` (WP1). Los endpoints
  `vault/*` son una extensión fuera del SOW, apagable con `VAULT_ENDPOINTS_ENABLED=false`.
- Notas del SDK 17 (API XDR distinta a la de versiones anteriores): [`docs/SDK17_XDR.md`](docs/SDK17_XDR.md).

## Licencia

MIT — ver [`LICENSE`](LICENSE).
