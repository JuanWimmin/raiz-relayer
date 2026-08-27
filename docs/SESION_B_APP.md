# Notas para la sesión B — migrar la app Android al relayer

Estas notas son para quien reemplace, en `Protocolo_Raiz/android`, las llamadas que hoy firman con
`walletManager.demoAdminKeyPair()` por llamadas HTTP a `raiz-relayer`. El contrato completo de
endpoints está en el [README](../README.md); aquí solo va lo que afecta al código Kotlin.

## 1. Cliente HTTP (`data/relayer/RelayerClient.kt`, Ktor)

- **Base URL**: `BuildConfig.RELAYER_URL` (desde `local.properties`, default = servicio desplegado).
- **Header obligatorio en todos los POST**: `x-raiz-app-key: ${BuildConfig.RELAYER_APP_KEY}`
  (`local.properties` → `BuildConfig`; nunca en el repo). `GET /v1/health` no lo necesita.
- **`content-type: application/json`**, body ≤ 8 KB (413 `PAYLOAD_TOO_LARGE` si no).
- **Timeout HTTP del cliente ≥ 90 s** (`requestTimeoutMillis = 90_000`, y `socketTimeoutMillis`
  igual). El relayer serializa una cola y cada job tiene un deadline de 75 s con propagación RPC y
  reintentos internos; un timeout de 30 s en la app cortaría respuestas válidas. Muestra spinner
  con texto tipo "Firmando en la red… puede tardar hasta un minuto".
- **`idempotency-key`**: genera un `UUID.randomUUID()` **por intento de usuario** (no por request
  HTTP) y reutilízalo en los reintentos automáticos de ese intento. Así, si la app pierde la
  respuesta por red, el reintento devuelve la misma respuesta (10 min de caché) en vez de
  disparar una segunda transacción. Mismo key con body distinto → 422 `IDEMPOTENCY_MISMATCH`.
- El faucet (`method`), mint y register devuelven `txHash` + `ledger`: guárdalos para la evidencia
  del SOW (`docs/evidencia_sow/d1/`).

## 2. Envelope y mapeo a `RaizResult` / `RaizErrorCode`

Toda respuesta es `{ ok: true, txHash, ledger, ... }` o
`{ ok: false, error: { code, message, retryable, details? } }`. `error.message` ya viene en
español y es apto para mostrar al usuario; `error.retryable` indica si tiene sentido un botón
"Reintentar" con la misma request.

`RaizErrorCode` hoy tiene: `INSUFFICIENT_BALANCE, INSUFFICIENT_POINTS, OUT_OF_STOCK,
NOT_A_RESIDENT, ALREADY_VOTED, PROPOSAL_CLOSED, QUORUM_NOT_REACHED, UNAUTHORIZED, NETWORK_ERROR,
SIMULATION_FAILED, PARSE_ERROR, NOT_FOUND, UNKNOWN`. **Propuesta: añadir `RATE_LIMITED`** (la app no
tiene guard "ya fondeado"; el 429 será el error más frecuente del faucet y merece su propio
mensaje/UI con cuenta atrás).

| HTTP | `error.code` | Tratamiento sugerido en la app |
|---|---|---|
| 200 | — | `RaizResult.Success(txHash)` |
| 409 | `ALREADY_RESIDENT` | **Éxito idempotente**: exactamente como hoy `SorobanClient.mintResident` trata `AlreadyResident (#5)`. No mostrar error. |
| 409 | `MERCHANT_EXISTS` | El comercio ya está registrado; el relayer NO sobrescribe. Tratar como éxito si el address es el propio (ya eres comercio) o mostrar "este comercio ya existe". |
| 404 | `ACCOUNT_NOT_FOUND` | La G… no existe en la red → llamar **friendbot primero** y reintentar (flujo de onboarding). `NOT_FOUND`. |
| 422 | `NO_TRUSTLINE` | La G… no tiene trustline USDC → **crear la trustline antes** (como hace hoy la app) y reintentar. `SIMULATION_FAILED` o un código nuevo `NO_TRUSTLINE` si se quiere UI específica. |
| 422 | `TRUSTLINE_DEAUTHORIZED` | Raro en testnet. `UNAUTHORIZED`. |
| 404 | `BARRIO_NOT_FOUND`, `BARRIO_ADMIN_NOT_SET` | Datos de barrio incoherentes con el deploy vigente (deployments.json desactualizado en assets). `NOT_FOUND`. |
| 422 | `CONTRACT_ERROR` | `details.contract` ∈ {pool, yield_adapter, blend_pool}, `details.contractCode`, `details.name?`. Para Yield: `INSUFFICIENT_LIQUIDITY` → mensaje de colchón; `INSUFFICIENT_SHARES` → nada que retirar. Default `SIMULATION_FAILED`. |
| 429 | `RATE_LIMITED` | `RATE_LIMITED` (nuevo). Usar `details.retryAfterSeconds` (también header `Retry-After`) para mostrar "vuelve a intentarlo en N min". |
| 400 | `VALIDATION_ERROR` | Bug de la app (body mal formado). `PARSE_ERROR`; loguear `details`. |
| 401 | `UNAUTHORIZED_APP` | API key incorrecta/rotada → la app necesita actualización. `UNAUTHORIZED`. |
| 413 | `PAYLOAD_TOO_LARGE` | `PARSE_ERROR`. |
| 422 | `IDEMPOTENCY_MISMATCH` | Bug de reutilización de UUID. `UNKNOWN`. |
| 502 | `UNAUTHORIZED_ADMIN` | Relayer mal configurado (no es admin). `UNAUTHORIZED`; no reintentar. |
| 502 | `TX_FAILED` | La tx se aplicó con fallo (`details.txResult`). `SIMULATION_FAILED`. |
| 503 | `FAUCET_EMPTY` | Sin USDC en el admin → mensaje "faucet agotado, avisa al equipo". `INSUFFICIENT_BALANCE`. |
| 503 | `RPC_UNREACHABLE`, `QUEUE_FULL` | `NETWORK_ERROR`, reintentable. |
| 503 | `RESTORE_REQUIRED` | TTL vencido en Blend (solo vault). `NETWORK_ERROR`, reintentable tras reseed. |
| 503 | `TX_TIMEOUT` | Trae `details.txHash`: la tx **puede aplicarse después**. No repetir a ciegas: consultar el hash (RPC `getTransaction`) o reintentar con la MISMA `idempotency-key`. `NETWORK_ERROR`. |
| 500 | `INTERNAL` | `UNKNOWN`. |
| — | fallo de red / timeout Ktor | `NETWORK_ERROR`. |

## 3. `GET /v1/health` como feature-flag

Llamar al arrancar (o al entrar en el flujo admin) y cachear ~1 min:

- `ok == true` → usar el relayer. Además:
  - `faucet.enabled == false` → ocultar/deshabilitar el botón de faucet (admin sin USDC).
  - `faucet.remainingToday == 0` → idem, con mensaje "cupo diario agotado".
  - `vaultEndpoints == false` → dejar la pantalla **Yield en solo lectura** (ver §5).
  - `contracts.*` debe coincidir con el `deployments.json` de `assets/`; si no, avisar en log (deploy desfasado).
- `ok == false` (503 `RPC_UNREACHABLE`) o error de red → mostrar el flujo admin como no disponible.
  No hay fallback local: el APK release ya no lleva la clave admin.

## 4. Faucet: cómo llega el USDC

- Destino **G…** → el relayer envía un **`payment` clásico** de `USDC:GATALTGT…` (`method: "payment"`).
  Aparece en Horizon `/accounts/{G}/payments`, así que el historial actual de la app
  (`HorizonStream`) lo muestra sin cambios.
- Destino **C…** (smart account / passkey) → **SAC `transfer`** (`method: "sac_transfer"`).
  No sale en `/payments` de Horizon; se ve en los eventos del contrato SAC (como hoy con
  `fundContractUsdc`).
- Monto: `amountStroops` como string (`"200000000"` = 20 USDC, 7 decimales). Asset en `asset`.
- Límite: 1 por address cada 10 min y 50/día global. La app **no** tiene guard "ya fondeado":
  gestiona el 429 con `retryAfterSeconds`.

## 5. Vault (`YieldViewModel.deposit()` / `withdrawAll()`)

Los dos consumidores del admin que el plan original no listaba:

- `deposit()` → `POST /v1/vault/deposit { barrioId, amountStroops }` (string decimal i128).
- `withdrawAll()` → `POST /v1/vault/redeem { barrioId, shares }`; las `shares` las lee la app
  (`yield_adapter.shares_of`) y las manda como string.
- Si `health.vaultEndpoints == false` (relayer con `VAULT_ENDPOINTS_ENABLED=false`), las rutas
  responden 404 `NOT_FOUND`: la pantalla Yield debe quedar en **solo lectura** (APY, posiciones)
  sin botones de depositar/retirar. Estos endpoints son una extensión fuera del SOW y se pueden
  apagar sin romper D1.

## 6. Checklist de cierre (D1)

1. `BuildConfig.RELAYER_URL` y `BuildConfig.RELAYER_APP_KEY` desde `local.properties`.
2. Call-sites migrados: `BecomeMerchantViewModel` (register), verificación de residente
   (mint), faucet de bienvenida (`fundContractUsdc`), `YieldViewModel` (vault).
3. `DEMO_ADMIN_SECRET` fuera de `build.gradle.kts`; `demoAdminKeyPair()` borrado de `WalletManager`
   y de todos sus usos. `DEMO_TOURIST_SECRET` / `DEMO_RESIDENT_SECRET` se quedan.
4. `versionName 0.2.0`, `versionCode 2`.
5. APK release descomprimido: `grep -rE "S[A-Z0-9]{55}"` = 0 y la G… del admin
   (`GBLS7PL5…`) tampoco hardcodeada (solo puede venir de `deployments.json` en assets).
6. Regresión en dispositivo físico (Motorola G04) de los 3 flujos + hashes a `docs/evidencia_sow/d1/`.
