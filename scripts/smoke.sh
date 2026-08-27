#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# smoke.sh — recorre todos los endpoints de un relayer VIVO y muestra el envelope
# de cada respuesta ({ ok, txHash?, error? }) junto al código HTTP.
#
# Uso:
#   RELAYER_APP_KEY=… ./scripts/smoke.sh                       # local
#   RELAYER_URL=https://raiz-relayer.fly.dev RELAYER_APP_KEY=… ./scripts/smoke.sh
#
# Variables opcionales para probar con direcciones reales:
#   SMOKE_ADDRESS   G… o C… destino (faucet / mint / register)
#   SMOKE_BARRIO_ID hex de 64 chars de un barrio real (ver deployments / seed)
#
# OJO: los POST consumen cupos diarios reales (20/día por endpoint, 50 faucet)
# y firman transacciones en testnet. Con los placeholders por defecto las
# llamadas fallan en validación/preflight (400/404) sin quemar cupo.
# Sin secretos: solo necesita la API key de la app.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RELAYER_URL="${RELAYER_URL:-http://localhost:8080}"
RELAYER_APP_KEY="${RELAYER_APP_KEY:-}"

# Placeholders: una G… sintácticamente válida pero (casi seguro) inexistente en
# testnet → el faucet debe responder 404 ACCOUNT_NOT_FOUND.
SMOKE_ADDRESS="${SMOKE_ADDRESS:-GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF}"
# barrioId de ejemplo: 64 ceros (hex válido, barrio inexistente → 404 BARRIO_NOT_FOUND).
# Sustituye por el id real (p. ej. el de "Centro" del seed) para una prueba completa.
SMOKE_BARRIO_ID="${SMOKE_BARRIO_ID:-0000000000000000000000000000000000000000000000000000000000000000}"

if [[ -z "$RELAYER_APP_KEY" ]]; then
    echo "Falta RELAYER_APP_KEY (la misma que en el .env del relayer)." >&2
    exit 1
fi

# Formatea JSON si hay jq; si no, lo imprime crudo.
# Con `set -o pipefail`, un jq que recibe algo que NO es JSON (p. ej. el cuerpo
# seguido de "HTTP 401") falla y tumba el script. Por eso `pretty` solo recibe
# el cuerpo, y el código HTTP se imprime por separado (ver `call`).
pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; echo; fi; }

# call [--no-key] MÉTODO RUTA [BODY]
#   El código HTTP va con -w a una variable y el cuerpo a un temporal, así jq
#   nunca ve texto mezclado. `--no-key` omite x-raiz-app-key (rutas públicas y
#   la prueba del 401).
call() {
    local with_key=1
    if [[ "${1:-}" == "--no-key" ]]; then
        with_key=0
        shift
    fi
    local method="$1" path="$2" body="${3:-}"
    local label=""
    if [[ "$with_key" -eq 0 ]]; then label=" (sin key)"; fi
    echo
    echo "── $method $path$label"
    if [[ -n "$body" ]]; then echo "   body: $body"; fi

    local tmp
    tmp=$(mktemp)
    local -a args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" "$RELAYER_URL$path")
    if [[ "$with_key" -eq 1 ]]; then
        args+=(-H "x-raiz-app-key: $RELAYER_APP_KEY")
    fi
    if [[ -n "$body" ]]; then
        args+=(-H "content-type: application/json" \
               -H "idempotency-key: smoke-$(date +%s)-$RANDOM" \
               --data "$body")
    fi
    local status
    status=$(curl "${args[@]}")
    echo "   HTTP $status"
    pretty < "$tmp"
    rm -f "$tmp"
}

echo "Relayer: $RELAYER_URL"

# 1. Liveness y health (públicos, no necesitan key).
#    /v1/live → 200 siempre que el proceso responda (es lo que sondea Fly).
#    /v1/health → 200 ok:true, o 503 RPC_UNREACHABLE si Stellar no responde.
call --no-key GET /v1/live
call --no-key GET /v1/health

# 2. Auth: sin key → 401 UNAUTHORIZED_APP con envelope
call --no-key POST /v1/faucet '{"address":"'"$SMOKE_ADDRESS"'"}'

# 3. Ruta inexistente → 404 NOT_FOUND con envelope (también cuenta para el límite por IP)
call GET /v1/no-existe

# 4. Validación → 400 VALIDATION_ERROR (no consume cupo)
call POST /v1/mint-resident '{"address":"no-es-una-direccion","barrioId":"abc"}'

# 5. Endpoints reales (con placeholders fallan en preflight sin quemar cupo)
call POST /v1/faucet '{"address":"'"$SMOKE_ADDRESS"'"}'

call POST /v1/mint-resident '{"address":"'"$SMOKE_ADDRESS"'","barrioId":"'"$SMOKE_BARRIO_ID"'"}'

call POST /v1/register-merchant '{
  "address": "'"$SMOKE_ADDRESS"'",
  "name": "Cafe Don Aurelio",
  "barrioId": "'"$SMOKE_BARRIO_ID"'",
  "latE6": 10421500,
  "lngE6": -75547800,
  "category": "cafe"
}'

# 6. Vault (404 NOT_FOUND si VAULT_ENDPOINTS_ENABLED=false). Montos i128 como string.
call POST /v1/vault/deposit '{"barrioId":"'"$SMOKE_BARRIO_ID"'","amountStroops":"20000000"}'
call POST /v1/vault/redeem  '{"barrioId":"'"$SMOKE_BARRIO_ID"'","shares":"1"}'

echo
echo "Smoke terminado. Con direcciones/barrio reales, verifica los txHash en:"
echo "  https://stellar.expert/explorer/testnet/tx/<txHash>"
