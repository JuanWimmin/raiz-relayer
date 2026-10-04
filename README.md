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

- la clave que firma por el admin vive **solo** en la variable de entorno `RELAYER_ADMIN_SECRET` del servidor;
- la app llama a un endpoint JSON con una API key estática y recibe el `txHash`;
- el APK release se verifica sin secretos (`grep -rE "S[A-Z0-9]{55}"` = 0).

**Cuenta admin ≠ clave que firma.** La *cuenta* admin es la `G…` de `deployments.admin`
(`GBLS7PL5…`): los contratos la guardan como admin, es el origen de todas las transacciones y no
cambia. La *clave* con la que firma el relayer puede ser la maestra de esa cuenta o un firmante
autorizado de ella. Desde la [rotación del 2026-10-04](#runbook-rotación-de-la-clave-del-admin) es un
firmante (`GB42NCO6…`): la maestra —la que viajó en el APK 0.1.0— tiene peso 0 y ya no firma nada.

## Arquitectura en 10 líneas

1. **Node 22 + TypeScript ESM**, **Fastify 5**, **`@stellar/stellar-sdk` 17** (RPC + Horizon), zod, pino.
2. `GET /v1/live` y `GET /v1/health` públicos; los `POST` exigen el header `x-raiz-app-key` (comparación en tiempo constante).
3. Validación zod estricta de bodies (≤ 8 KB) → **preflights** (existencia de cuenta/contrato, trustline, `get_merchant`, balance del admin).
4. **Rate-limits en memoria**: por IP (60/min, clave `Fly-Client-IP`), por address (faucet 1/10 min) y cupos diarios UTC por endpoint.
5. **Cola serializada** (`SerialQueue`): una transacción a la vez porque hay **una** cuenta admin = **un** sequence number.
6. Pipeline único `submit()`: simulate → assemble → sign → send → poll, con deadline de 70 s (y 15 s por request al RPC), reintentos ante propagación RPC y **política anti doble gasto** (máx. 1 rebuild, solo si la tx anterior es `NOT_FOUND` y su `maxTime` venció).
7. **Allowlist de 6 contratos** (`pool, governance, treasury, rewards, yield_adapter, usdc_sac` de `config/deployments.testnet.json`); cualquier otro `contractId` se rechaza.
8. Errores de contrato **atribuidos al contrato que falló** (eventos de diagnóstico), porque los códigos numéricos colisionan entre Pool, Governance, adapter y SAC.
9. `idempotency-key` opcional → misma respuesta durante 10 min; peticiones concurrentes comparten la promesa. Un `TX_TIMEOUT` con `txHash` también se cachea (reintentar con la misma key devuelve el mismo hash y **no re-firma**).
10. Logs pino con `redact` (secret, `x-raiz-app-key`, `authorization`); `sim.error` crudo solo en `debug`.

---

## Endpoints

Base: `/v1`. Todos JSON (`content-type: application/json`), body ≤ 8 KB.

**Auth:** header `x-raiz-app-key: <RELAYER_APP_KEY>` en todos los POST (401 si falta o no coincide).
`GET /v1/live` y `GET /v1/health` son públicos (pero están bajo el limitador por IP, igual que
las rutas inexistentes: un 404 también cuenta).

**Idempotencia (opcional):** header `idempotency-key` (≤ 64 chars) → la misma respuesta durante
10 min; misma key con body distinto → `422 IDEMPOTENCY_MISMATCH`; peticiones concurrentes con la
misma key esperan la misma promesa (no se firma dos veces).

Los errores **no** se cachean (un `RPC_UNREACHABLE`, `RATE_LIMITED`, etc. se puede reintentar con
la misma key y vuelve a ejecutarse), con **una excepción**: `503 TX_TIMEOUT` con `details.txHash`
**sí se cachea 10 min por `idempotency-key`**. Ese error significa que el envelope ya salió firmado
y puede aplicarse todavía; reintentar con la misma key devuelve el **mismo** `TX_TIMEOUT` con el
**mismo** `txHash` y **NO re-firma** (si re-firmara con secuencia nueva habría doble gasto, p. ej.
dos `deposit_idle_to_vault`). La app debe esperar ~1 min y consultar/refrescar ese hash (RPC
`getTransaction`), no repetir la operación. Un `TX_TIMEOUT` con `txHash: null` (la cola venció
antes de enviar nada) no se cachea y sí es seguro reintentar.

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
| 404 | `ACCOUNT_NOT_FOUND` | faucet a G… sin crear (Horizon 404 / SAC #6) → "usa friendbot primero"; faucet a C… cuyo contrato no está desplegado |
| 404 | `NOT_FOUND` | ruta inexistente (o `/v1/vault/*` con `VAULT_ENDPOINTS_ENABLED=false`) |
| 409 | `ALREADY_RESIDENT` | Governance #5 |
| 409 | `MERCHANT_EXISTS` | preflight `get_merchant`: ya registrado, no se sobrescribe |
| 413 | `PAYLOAD_TOO_LARGE` | body > 8 KB |
| 422 | `NO_TRUSTLINE` | G… sin trustline USDC (preflight Horizon / `op_no_trust` / SAC #13) |
| 422 | `TRUSTLINE_DEAUTHORIZED` | SAC #11 |
| 422 | `IDEMPOTENCY_MISMATCH` | misma `idempotency-key`, body distinto |
| 422 | `CONTRACT_ERROR` | otro error de contrato; `details.contract`, `details.contractCode`, `details.name?` |
| 429 | `RATE_LIMITED` | `details.retryAfterSeconds` + header **`Retry-After`** |
| 502 | `UNAUTHORIZED_ADMIN` | El relayer no puede actuar como admin (mal configurado): #3 en Pool/Governance/adapter, o la red rechaza su firma (`txBadAuth` / `opBadAuth`) porque la clave de `RELAYER_ADMIN_SECRET` no está autorizada para firmar por la cuenta admin (`details.txResult`, `details.admin`, `details.signer`) → [rotación](#runbook-rotación-de-la-clave-del-admin) |
| 502 | `TX_FAILED` | tx aplicada con fallo; `details.txResult` |
| 503 | `FAUCET_EMPTY` | balance USDC del admin < monto → [runbook](#runbook-re-fondear-el-faucet) |
| 503 | `RPC_UNREACHABLE` | RPC/Horizon caídos o sin responder a tiempo (`/v1/health` corta a los 8 s; cada request al RPC a los `RPC_REQUEST_TIMEOUT_MS`) |
| 503 | `QUEUE_FULL` | cola > `QUEUE_CAP` (20) |
| 503 | `RESTORE_REQUIRED` | TTL vencido en entradas de Blend (vault) |
| 503 | `TX_TIMEOUT` | deadline vencido con tx en vuelo; `details.txHash` — **puede aplicarse después**. Con `txHash` se cachea 10 min por `idempotency-key`: reintentar con la misma key devuelve el mismo hash y no re-firma |
| 500 | `INTERNAL` | error no clasificado |

`retryable: true` solo en `RATE_LIMITED`, `RPC_UNREACHABLE`, `QUEUE_FULL`, `TX_TIMEOUT`, `RESTORE_REQUIRED`.

### `GET /v1/live` (público, sin red)

```jsonc
200 { "ok": true, "uptimeSeconds": 123 }
```

**Liveness**: "el proceso responde". No consulta Stellar, no tiene caché y nunca devuelve 503.
Es lo que sondean el `[[http_service.checks]]` de `fly.toml` y el `HEALTHCHECK` del Dockerfile.
**No lo use la app** como feature-flag: no dice nada del estado de la red.

### `GET /v1/health` (público, cache 10 s)

```jsonc
200 { "ok": true, "network": "testnet", "protocolVersion": 28, "admin": "GBLS7PL5…",
      "signer": "GB42NCO6…", "signerAuthorized": true,
      "contracts": { "pool": "…", "governance": "…", "treasury": "…", "rewards": "…", "yield_adapter": "…", "usdc_sac": "…" },
      "faucet": { "enabled": true, "amountStroops": "200000000", "adminUsdcStroops": "3412750000", "remainingToday": 50 },
      "limits": { "faucetPerAddressMinutes": 10, "faucetDaily": 50, "registerDaily": 20, "mintDaily": 20, "vaultDaily": 20 },
      "vaultEndpoints": true, "queue": { "pending": 0 }, "version": "0.2.0", "uptimeSeconds": 123 }
503 { "ok": false, "error": { "code": "RPC_UNREACHABLE", … } }
```

**Feature-flag** de la app: `ok` (relayer + Stellar operativos), `faucet.enabled` y
`vaultEndpoints` para mostrar u ocultar botones. Devuelve **503 `RPC_UNREACHABLE` cuando RPC/Horizon
fallan o tardan más de 8 s** (el error no se cachea; el siguiente GET reintenta). Por eso el proxy
NO sondea esta ruta: una caída de Stellar debe verse como `ok:false`, no como "relayer muerto".

**Quién firma** (para quien opera; la app no usa estos campos): `admin` es la **cuenta** admin
(`deployments.admin`: origen de las transacciones y dueña del USDC del faucet). `signer` es la
clave pública con la que firma el relayer —la que deriva de `RELAYER_ADMIN_SECRET`: la maestra de
esa cuenta o un firmante suyo— y `signerAuthorized` dice si esa clave puede firmar por la cuenta
según el ledger:

| `signerAuthorized` | Significado |
|---|---|
| `true` | `signer` está entre los `signers` de la cuenta con peso suficiente |
| `false` | no lo está: p. ej. se retiró la clave con el relayer en marcha, sin redesplegar. Los POST responden `502 UNAUTHORIZED_ADMIN` |
| `null` | aún no se pudo verificar: Horizon no ha respondido a esa comprobación, ni al arrancar ni después |

Se comprueba [al arrancar](#verificación-del-firmante-al-arrancar) y se repite con cada lectura de
salud (misma caché de 10 s), así que sigue al ledger aunque los firmantes cambien con el relayer en
marcha. Una comprobación que falla no borra el último resultado verificado.

| | `/v1/live` | `/v1/health` |
|---|---|---|
| Quién la usa | Fly / Docker (proceso vivo) | La app (feature-flag) |
| Toca la red | No | Sí (RPC + Horizon, cache 10 s, tope 8 s) |
| 503 posible | Nunca | Sí, cuando cae Stellar |

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

El relayer actúa como `barrio_admin = GBLS7PL5…` (la cuenta admin; el seed la configura como admin
de los 3 barrios). Soulbound: nunca hay `transfer`. Cupo: 20/día.

### `POST /v1/faucet` → 20 USDC de Blend (`FAUCET_AMOUNT_STROOPS`)

```jsonc
req  { "address": "G…|C…" }
200  { "ok": true, "txHash": "…", "ledger": n, "amountStroops": "200000000",
       "asset": "USDC:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56", "method": "payment|sac_transfer" }
404  ACCOUNT_NOT_FOUND · 422 NO_TRUSTLINE · 422 TRUSTLINE_DEAUTHORIZED · 503 FAUCET_EMPTY · 429 RATE_LIMITED
```

- `G…` → op **`payment` clásica** (aparece en Horizon `/payments`, que es lo que lee el historial de la app).
- `C…` → **SAC `transfer(admin, C…, i128)`** sobre `usdc_sac`, **solo si la smart account está
  desplegada** (el preflight comprueba que el contrato existe en la red; si no, `404
  ACCOUNT_NOT_FOUND`). Una C… derivada pero aún no desplegada no recibe faucet: la app debe
  desplegar la smart account primero.

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
| `RELAYER_ADMIN_SECRET` | Clave `S…` con la que firma el relayer: la maestra de la cuenta admin o un firmante autorizado de ella. La **cuenta** es siempre `deployments.admin` (`GBLS7PL5…`) y no depende de esta variable. Si la clave no puede firmar por esa cuenta, el proceso no arranca ([verificación on-chain](#verificación-del-firmante-al-arrancar)). Nunca al repo ni a logs. |
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
| `RATE_PER_IP_PER_MINUTE` | `60` | Limitador por IP. Clave = header `Fly-Client-IP` (lo escribe fly-proxy; **no** `X-Forwarded-For`, que el cliente puede rellenar), o la IP del socket si no viene. Cubre también los 404 |
| `VAULT_ENDPOINTS_ENABLED` | `true` | `false` → `/v1/vault/*` responde 404 |
| `LOG_LEVEL` | `info` | pino (`fatal…trace`, `silent`) |
| `DEPLOYMENTS_FILE` | `config/deployments.testnet.json` | Copia literal del `deployments.json` del monorepo |
| `QUEUE_CAP` | `20` | Jobs en espera antes de `503 QUEUE_FULL` |
| `JOB_DEADLINE_MS` | `70000` | Deadline del pipeline por job (simulate → poll) |
| `RPC_REQUEST_TIMEOUT_MS` | `15000` | Timeout de **cada** request HTTP al RPC/Horizon (un upstream colgado no bloquea la cola) |
| `JOB_TIMEOUT_MS` | `90000` | Timeout duro del job. Regla validada al arrancar: `JOB_TIMEOUT_MS >= JOB_DEADLINE_MS + RPC_REQUEST_TIMEOUT_MS + 5000` (el deadline puede vencer en mitad de una request al RPC que aún tarda hasta `RPC_REQUEST_TIMEOUT_MS`) |
| `SUBMIT_ATTEMPTS` | `5` | Reintentos de `sendTransaction` ante `TRY_AGAIN_LATER` / red |
| `SUBMIT_BACKOFF_MS` | `3000` | Espera entre reintentos |
| `TX_TIMEOUT_SECONDS` | `30` | `maxTime` de la transacción |
| `IDEMPOTENCY_TTL_MS` | `600000` | Vida de la caché de `idempotency-key` (10 min) |
| `HEALTH_CACHE_MS` | `10000` | Caché de `/v1/health` (la ida a RPC/Horizon se corta a los 8 s, fijo) |

Consecuencia para el cliente (sesión B): el **timeout HTTP de la app debe ser ≥ 95 s**
(`JOB_DEADLINE_MS` 70 s + `RPC_REQUEST_TIMEOUT_MS` 15 s + margen), porque una respuesta válida
puede tardar hasta `JOB_TIMEOUT_MS`. Ver [`docs/SESION_B_APP.md`](docs/SESION_B_APP.md).

### Verificación del firmante al arrancar

Hasta la 0.1.0 el proceso exigía que `RELAYER_ADMIN_SECRET` derivara exactamente a
`deployments.admin`. Desde la 0.2.0 la clave puede ser un firmante de esa cuenta, así que la
comprobación pasa a hacerse **contra el ledger**, con el mismo espíritu (nunca correr con una clave
que no puede firmar por el admin): antes de escuchar, el proceso carga la cuenta admin de Horizon y
busca la clave pública del secret entre sus `signers`.

| Resultado | Cuándo | Qué hace el relayer |
|---|---|---|
| autorizado | la clave está en `signers` con peso ≥ umbral medio de la cuenta (y ≥ 1: con umbral 0 sigue haciendo falta una firma válida) | arranca; `signerAuthorized: true` |
| no autorizado | no está en `signers`, tiene peso 0 (p. ej. la maestra ya deshabilitada), su peso no llega al umbral, o la cuenta no existe en la red | **no arranca**: log `fatal` con la cuenta, el firmante y el motivo, y `exit 1` |
| sin verificar | Horizon no responde tras 3 intentos (esperas de 1 s y 2 s) | arranca igualmente con un `warn` —un parpadeo de Horizon no debe dejar la máquina en crash-loop— y queda *sin verificar* hasta la primera lectura correcta de `/v1/health`, que repite la comprobación |

`payment` e `invoke_host_function` —lo único que envía el relayer— son operaciones de umbral
**medio**; el alto (el de `set_options`) no cuenta. Si la cuenta tuviera el umbral bajo por encima
del medio también se exige ese, porque la red valida la transacción contra el bajo. Si aun así la
red rechaza una firma (`txBadAuth` / `opBadAuth`), el POST responde `502 UNAUTHORIZED_ADMIN`, no
reintentable.

---

## Setup local

Requisitos: Node **22** (`.nvmrc`), npm, [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
con la identidad `raiz-admin-signer`: la clave del firmante vigente de la cuenta admin. La cuenta
sigue siendo la de `deployments.admin` (`GBLS7PL5…`); la identidad `raiz-admin` del monorepo es su
clave **maestra**, que desde la rotación tiene peso 0 y ya no sirve para firmar.

```bash
git clone https://github.com/JuanWimmin/raiz-relayer && cd raiz-relayer
npm ci
cp .env.example .env
# Edita .env: RELAYER_APP_KEY=$(openssl rand -hex 24) y el secret desde la CLI (no lo pegues a mano):
export RELAYER_ADMIN_SECRET=$(stellar keys show raiz-admin-signer)
npm run dev                # tsx watch src/index.ts
curl -s http://localhost:8080/v1/health | jq .      # signerAuthorized: true
```

Prueba de humo de todos los endpoints contra un relayer vivo:

```bash
RELAYER_APP_KEY=… ./scripts/smoke.sh                      # local
RELAYER_URL=https://raiz-relayer.fly.dev RELAYER_APP_KEY=… ./scripts/smoke.sh
```

## Tests

```bash
npm run typecheck   # tsc sobre src/ y test/
npm test            # vitest: rate-limit, cola, idempotencia, encode ScVal, errores, firmante (Horizon falso), submit (RPC falso), rutas (fastify.inject)
```

Integración real contra testnet (firma transacciones de verdad y consume cupos):

```bash
export RELAYER_ADMIN_SECRET=$(stellar keys show raiz-admin-signer)
export RELAYER_APP_KEY=cualquier-cosa-de-16-chars
RELAYER_IT=1 npm run test:it
```

Necesita: red hacia `soroban-testnet.stellar.org` y `horizon-testnet.stellar.org`, la cuenta admin
con XLM y ≥ 40 USDC de Blend (ver runbook), la clave del secret como firmante vigente de esa cuenta
(es lo primero que comprueba la suite) y `config/deployments.testnet.json` igual al deploy vigente.
Timeout por test: 180 s.

---

## Docker y Fly.io

```bash
docker build -t raiz-relayer .
docker run --rm -p 8080:8080 -e NETWORK=testnet \
  -e RELAYER_ADMIN_SECRET="$(stellar keys show raiz-admin-signer)" \
  -e RELAYER_APP_KEY="$RELAYER_APP_KEY" raiz-relayer
```

Fly.io (región `iad` — Ashburn; `bog` y `mia` están deprecadas en Fly y no admiten máquinas nuevas — `fly.toml` incluido):

```bash
fly launch --no-deploy            # usa el fly.toml existente; no crees Postgres ni Redis
fly secrets set NETWORK=testnet \
  RELAYER_ADMIN_SECRET="$(stellar keys show raiz-admin-signer)" \
  RELAYER_APP_KEY="$(openssl rand -hex 24)"
fly deploy --ha=false             # ← SIEMPRE con --ha=false
```

`raiz-admin-signer` es la identidad del firmante vigente de la cuenta admin (la cuenta sigue siendo
la de `deployments.admin`). Si el secret no puede firmar por esa cuenta la máquina no arranca: mira
`fly logs` (línea `fatal` con el motivo) y el [runbook de rotación](#runbook-rotación-de-la-clave-del-admin).

**Por qué una sola máquina:** el relayer mantiene **una cola serializada por cuenta admin**. Hay una
única cuenta admin y, por tanto, un único sequence number en la red. Con dos máquinas cada una
lleva su propia cola y se pisan la secuencia: `txBadSeq` intermitentes, reintentos que no arreglan
nada y cupos diarios duplicados (los contadores son por proceso). `fly deploy` sin `--ha=false`
crea dos máquinas por defecto. `fly.toml` fija `min_machines_running = 1`,
`auto_stop_machines = "off"` y `kill_timeout = 120` para que el `SIGTERM` pueda drenar la cola.

**Apagado ordenado:** ante `SIGTERM`, el proceso cierra el servidor HTTP y drena la cola con un
**tope total de 100 s** para las dos fases (Fastify 5 espera a las respuestas en vuelo, y esas
esperan a la cola, así que `app.close()` solo no bastaría como límite). Si al vencer quedan
conexiones abiertas se cortan (`closeAllConnections`) antes de salir, siempre por debajo de los
120 s de `kill_timeout`.

**Health check del proxy:** `[[http_service.checks]]` apunta a **`/v1/live`** (proceso vivo, sin
red), no a `/v1/health`. Si sondeara `/v1/health`, una caída de Stellar (503) haría que Fly
sacara al relayer de servicio justo cuando la app necesita leer `ok:false` para desactivar el
flujo admin. El `HEALTHCHECK` del Dockerfile sigue el mismo criterio.

---

## Límites y cupos

| Recurso | Límite | Ámbito |
|---|---|---|
| Cualquier ruta (incluidos 404 y `/v1/live`) | 60 req/min | por IP (`Fly-Client-IP`; nunca `X-Forwarded-For`) |
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
- **La ventana por address del faucet también protege a las `C…`.** Antes bastaba con derivar
  direcciones de contrato (gratis, sin tocar la red) para rotar destinos y vaciar el cupo diario;
  ahora el faucet a `C…` exige que el contrato **exista en la red** (`404 ACCOUNT_NOT_FOUND` si
  no), y desplegar una smart account cuesta XLM y una transacción por dirección. Para `G…` la
  barrera equivalente es friendbot (cuenta creada en la red).
- **El limitador por IP no se evade con `X-Forwarded-For`.** La clave del cubo es el header
  `Fly-Client-IP`, que escribe fly-proxy en cada request y el cliente no puede fijar desde fuera;
  `trustProxy` es una función que solo confía en el proxy de Fly (`fdaa::/16`) y loopback, así que
  `req.ip` (y el `remoteAddress` de los logs) tampoco se envenena rellenando `X-Forwarded-For`.
  Los 404 pasan por el mismo cubo. Sigue siendo por IP: una NAT grande comparte los 60/min.
- **La clave que firma solo está en env** (`RELAYER_ADMIN_SECRET`); al arrancar el proceso
  verifica on-chain que esa clave puede firmar por la cuenta admin (`deployments.admin`) y se niega
  a arrancar si no; pino redacta secret y headers; el `sim.error` crudo solo en `debug`.
- **La clave maestra del admin estuvo expuesta, y se rotó.** La clave maestra de la cuenta admin
  estuvo embebida en el APK 0.1.0 de la app (`DEMO_ADMIN_SECRET`): quien tuviera ese APK podía
  extraerla y firmar como admin del protocolo. El **2026-10-04 se rotó**: la cuenta admin conserva
  su dirección (`GBLS7PL5…`, la que guardan los contratos), la clave maestra queda con **peso 0**
  —ya no autoriza nada— y el relayer firma con un firmante nuevo (`GB42NCO6…`) que nunca estuvo en
  un APK. La rotación corta el acceso de ahí en adelante; no deshace lo que se hubiera firmado con
  la clave vieja mientras fue válida (el historial de la cuenta es público en Horizon).
  Procedimiento: [runbook](#runbook-rotación-de-la-clave-del-admin).
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

## Runbook: rotación de la clave del admin

**Cuándo:** la clave con la que se firma por el admin se ha expuesto (o se sospecha), o toca
cambiarla. **Qué cambia:** solo *quién firma*. La **cuenta admin no cambia** (`deployments.admin`,
`GBLS7PL5…`): los contratos guardan esa `G…` como admin, así que no se tocan contratos,
`deployments.json` ni la app. Se cambian los firmantes de la cuenta (operación clásica
`set_options`) y el secret del relayer.

El orden es lo que la hace segura: **primero** se añade la clave nueva y se comprueba que el
relayer firma con ella; **solo después** se retira la vieja. En ningún momento la cuenta se queda
sin un firmante válido. Con Stellar CLI (≥ 23):

```bash
NETWORK=testnet
ADMIN=$(jq -r .admin config/deployments.testnet.json)   # la CUENTA admin → GBLS7PL5… (no cambia)
ACTUAL=raiz-admin           # identidad que firma por la cuenta ANTES de rotar (el 2026-10-04, la maestra)
NUEVO=raiz-admin-signer     # identidad nueva (en la siguiente rotación: ACTUAL=raiz-admin-signer y NUEVO=otro nombre)

# (a) Generar la clave nueva. No hace falta fondearla: es un firmante, no una cuenta.
stellar keys generate "$NUEVO"
NUEVO_G=$(stellar keys address "$NUEVO")

# (b) Añadirla como firmante de la cuenta admin, con peso 1. Firma la clave ACTUAL.
stellar tx new set-options --source-account "$ADMIN" --sign-with-key "$ACTUAL" --network "$NETWORK" \
  --signer "$NUEVO_G" --signer-weight 1

# (c) Desplegar el relayer con RELAYER_ADMIN_SECRET = la clave nueva y comprobar que firma.
#     El secret entra por stdin (no queda en la línea de comandos); Fly reinicia la máquina.
#     OJO si aún corre una versión < 0.2.0: despliega ANTES la 0.2.0 (ver notas).
printf 'RELAYER_ADMIN_SECRET=%s\n' "$(stellar keys show "$NUEVO")" | fly secrets import -a raiz-relayer
curl -s https://raiz-relayer.fly.dev/v1/health | jq '{version, admin, signer, signerAuthorized}'
#   → admin = $ADMIN (igual que antes), signer = $NUEVO_G, signerAuthorized = true
#     (si `signer` aún es el anterior, la máquina no ha terminado de reiniciar: repite el curl)
#   + un faucet REAL (POST /v1/faucet a una G… con trustline): el txHash debe aplicarse.

# (d) SOLO ENTONCES retirar la clave vieja. La transacción la firma la clave NUEVA: si no
#     pudiera firmar por la cuenta, falla y nada cambia; así es imposible bloquear la cuenta.
#     · La vieja es la clave MAESTRA (caso del 2026-10-04): peso 0 y umbrales 1/1/1.
stellar tx new set-options --source-account "$ADMIN" --sign-with-key "$NUEVO" --network "$NETWORK" \
  --master-weight 0 --low-threshold 1 --med-threshold 1 --high-threshold 1
#     · La vieja es OTRO firmante (rotaciones posteriores; la maestra ya está en 0): quitarlo.
#       stellar tx new set-options --source-account "$ADMIN" --sign-with-key "$NUEVO" --network "$NETWORK" \
#         --signer "$(stellar keys address "$ACTUAL")" --signer-weight 0

# (e) Verificar en Horizon los firmantes y los umbrales, y que el relayer sigue autorizado.
curl -s "https://horizon-testnet.stellar.org/accounts/$ADMIN" | jq '{thresholds, signers}'
curl -s https://raiz-relayer.fly.dev/v1/health | jq '{signer, signerAuthorized}'   # true (cache 10 s)
```

Resultado esperado de (e) tras la rotación del 2026-10-04 (Horizon lista la clave maestra aunque
tenga peso 0):

```jsonc
{ "thresholds": { "low_threshold": 1, "med_threshold": 1, "high_threshold": 1 },
  "signers": [ { "weight": 1, "key": "GB42NCO6…", "type": "ed25519_public_key" },     // firmante del relayer
               { "weight": 0, "key": "GBLS7PL5…", "type": "ed25519_public_key" } ] }  // maestra, deshabilitada
```

Lo que se ejecutó ese día, con horas y hashes:
[`docs/evidencia/rotacion_clave_2026-10-04.md`](docs/evidencia/rotacion_clave_2026-10-04.md).

Notas:

- **(b) siempre con `--source-account "$ADMIN"`.** La transacción sale de la *cuenta* y la firma la
  identidad actual. Solo cuando esa identidad es la clave maestra (como el 2026-10-04) vale el
  atajo `--source-account "$ACTUAL"`, porque su dirección *es* la cuenta. Con un firmante, ese atajo
  apuntaría a la dirección del firmante, que no es la cuenta admin.
- **(c) partiendo de un relayer 0.1.0:** esa versión exigía que el secret derivara a
  `deployments.admin` y **no arranca** con la clave de un firmante, así que no cambies el secret con
  ella en marcha. Deja el secret preparado sin reiniciar (`… | fly secrets import --stage -a raiz-relayer`)
  y despliega la 0.2.0 (`fly deploy --ha=false`), que arranca ya con la clave nueva: así se hizo el
  2026-10-04. Con una 0.2.0 o posterior ya en marcha basta el cambio de secret de arriba.
- **Si (c) falla** (`signerAuthorized` no es `true`, o la máquina no arranca: `fly logs` trae una
  línea `fatal` con la cuenta, el firmante y el motivo), vuelve a poner el secret anterior: hasta
  (d) la clave vieja sigue siendo válida y no se ha perdido nada.
- **Pesos y umbrales en (d):** el firmante nuevo debe pesar al menos tanto como el umbral más alto
  que fijes (aquí 1 ≥ 1/1/1). Un umbral por encima del peso total de los firmantes sí bloquearía la
  cuenta, y eso ya no lo impide firmar con la clave nueva.
- **Si se hace (d) sin (c)** (el relayer sigue con la clave vieja): los POST responden
  `502 UNAUTHORIZED_ADMIN` y `/v1/health` pasa a `signerAuthorized: false`. Se arregla con (c).
- **Fuera de este repo:** todo lo que firmaba con la identidad vieja deja de valer. En el monorepo,
  los comandos con `--source raiz-admin` pasan a
  `--source-account "$ADMIN" --sign-with-key raiz-admin-signer`.
- El secret viejo se da por quemado: bórralo de donde estuviera (`fly secrets`, `.env`, gestores) y
  no lo reutilices.

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
Con Stellar CLI (≥ 23); no hace falta ninguna clave del admin (el donante firma lo suyo):

```bash
NETWORK=testnet
ADMIN=$(jq -r .admin config/deployments.testnet.json)   # la CUENTA admin → GBLS7PL5…
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
curl -s "https://horizon-testnet.stellar.org/accounts/$ADMIN" \
  | jq '.balances[] | select(.asset_code=="USDC" and .asset_issuer=="GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56") | .balance'
curl -s https://raiz-relayer.fly.dev/v1/health | jq .faucet     # enabled=true, adminUsdcStroops actualizado (cache 10 s)
```

Si el admin también anda corto de XLM (fees), `curl -s "https://friendbot.stellar.org/?addr=$ADMIN"`
(friendbot) o cualquier faucet de XLM de testnet.

---

## Verificación por un revisor

Sin credenciales:

```bash
curl -s https://raiz-relayer.fly.dev/v1/live   | jq .    # { ok: true, uptimeSeconds } — proceso vivo
curl -s https://raiz-relayer.fly.dev/v1/health | jq .
```

`/v1/health` debe devolver `ok: true`, `network: "testnet"`, `admin: "GBLS7PL5…"` (la cuenta),
`signer: "GB42NCO6…"` con `signerAuthorized: true` (la clave con la que firma el relayer, autorizada
en esa cuenta) y los contratos iguales a `config/deployments.testnet.json` (= `deployments.json` del
monorepo). Que `signer` es un firmante de la cuenta y que la clave maestra tiene peso 0 se comprueba
sin fiarse del relayer:

```bash
curl -s https://horizon-testnet.stellar.org/accounts/GBLS7PL5Y65DHQIPMJO6HVQLX4FXEEHQDWHGSBUTGT4V6ZV2IOACYC2P \
  | jq '{thresholds, signers}'
```

Con la API key (la del APK o una que te pase el equipo), un `POST` devuelve un `txHash`; se
comprueba on-chain en Stellar Expert:

```
https://stellar.expert/explorer/testnet/tx/<txHash>
```

Allí se ve la cuenta origen (`GBLS7PL5…`, el admin), quién firmó (el firmante del relayer,
`GB42NCO6…`; en las transacciones anteriores al 2026-10-04, la clave maestra de la propia cuenta),
la operación (`invokeHostFunction` o `payment`) y el contrato invocado. Los hashes de la sesión de
evidencia están archivados en el monorepo, `docs/evidencia_sow/d1/`.

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
