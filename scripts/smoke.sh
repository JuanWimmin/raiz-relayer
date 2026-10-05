#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# smoke.sh — recorre todos los endpoints de un relayer VIVO y muestra el envelope
# de cada respuesta ({ ok, txHash?, error? }) junto al código HTTP.
#
# Uso (sin credenciales: desde la 0.3.0 el relayer no tiene API key):
#   ./scripts/smoke.sh                                            # local
#   RELAYER_URL=https://raiz-relayer.fly.dev ./scripts/smoke.sh   # desplegado
#
# Variables opcionales para probar con direcciones reales:
#   SMOKE_ADDRESS   G… o C… destino (faucet / mint / register)
#   SMOKE_BARRIO_ID hex de 64 chars de un barrio real (ver deployments / seed)
#
# OJO: los POST son reales y consumen cupos diarios, los de tu IP y los globales
# (README § Límites y cupos). Con los placeholders por defecto nada llega a
# firmarse: el faucet y la validación se rechazan antes de consumir (404/400),
# pero mint, registro y vault se rechazan al simular (404) y cada pasada gasta
# una unidad de su cupo (dos el vault).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RELAYER_URL="${RELAYER_URL:-http://localhost:8080}"

# Placeholders: una G… sintácticamente válida pero (casi seguro) inexistente en
# testnet → el faucet debe responder 404 ACCOUNT_NOT_FOUND.
SMOKE_ADDRESS="${SMOKE_ADDRESS:-GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF}"
# barrioId de ejemplo: 64 ceros (hex válido, barrio inexistente → 404 BARRIO_NOT_FOUND).
# Sustituye por el id real (p. ej. el de "Centro" del seed) para una prueba completa.
SMOKE_BARRIO_ID="${SMOKE_BARRIO_ID:-0000000000000000000000000000000000000000000000000000000000000000}"

# Formatea JSON si hay jq; si no, lo imprime crudo.
# Con `set -o pipefail`, un jq que recibe algo que NO es JSON (p. ej. el cuerpo
# seguido de "HTTP 404") falla y tumba el script. Por eso `pretty` solo recibe
# el cuerpo, y el código HTTP se imprime por separado (ver `call`).
pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; echo; fi; }

# call [--legacy-key] MÉTODO RUTA [BODY]
#   El código HTTP va con -w a una variable y el cuerpo a un temporal, así jq
#   nunca ve texto mezclado. `--legacy-key` añade la cabecera x-raiz-app-key
#   que siguen enviando los APK 0.2.0/0.3.0, con un valor cualquiera: el relayer
#   debe ignorarla.
call() {
    local legacy_key=0
    if [[ "${1:-}" == "--legacy-key" ]]; then
        legacy_key=1
        shift
    fi
    local method="$1" path="$2" body="${3:-}"
    local label=""
    if [[ "$legacy_key" -eq 1 ]]; then label=" (con x-raiz-app-key heredada)"; fi
    echo
    echo "── $method $path$label"
    if [[ -n "$body" ]]; then echo "   body: $body"; fi

    local tmp
    tmp=$(mktemp)
    local -a args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" "$RELAYER_URL$path")
    if [[ "$legacy_key" -eq 1 ]]; then
        args+=(-H "x-raiz-app-key: clave-heredada-que-se-ignora")
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

# 1. Liveness y health.
#    /v1/live → 200 siempre que el proceso responda (es lo que sondea Fly).
#    /v1/health → 200 ok:true, o 503 RPC_UNREACHABLE si Stellar no responde.
call GET /v1/live
call GET /v1/health

# 2. Sin API key: un POST con la cabecera heredada de los APK antiguos responde
#    igual que sin ella (paso 5: 404 ACCOUNT_NOT_FOUND con el placeholder), nunca 401.
call --legacy-key POST /v1/faucet '{"address":"'"$SMOKE_ADDRESS"'"}'

# 3. Ruta inexistente → 404 NOT_FOUND con envelope (también cuenta para el límite por IP)
call GET /v1/no-existe

# 4. Validación → 400 VALIDATION_ERROR (no consume cupo)
call POST /v1/mint-resident '{"address":"no-es-una-direccion","barrioId":"abc"}'

# 5. Endpoints reales. Con placeholders: el faucet falla en el preflight (sin
#    consumir cupo); mint y registro, al simular (gastan 1 de cupo cada uno).
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
#    Con el barrio placeholder fallan al simular: gastan 1 de cupo cada una.
call POST /v1/vault/deposit '{"barrioId":"'"$SMOKE_BARRIO_ID"'","amountStroops":"20000000"}'
call POST /v1/vault/redeem  '{"barrioId":"'"$SMOKE_BARRIO_ID"'","shares":"1"}'

echo
echo "Smoke terminado. Con direcciones/barrio reales, verifica los txHash en:"
echo "  https://stellar.expert/explorer/testnet/tx/<txHash>"
