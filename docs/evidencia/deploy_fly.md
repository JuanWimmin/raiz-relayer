# Deploy del relayer en Fly.io — 2026-09-06

| Dato | Valor |
|---|---|
| URL pública | https://raiz-relayer.fly.dev |
| App / org | `raiz-relayer` / personal |
| Región | `iad` (Ashburn). `bog` y `mia` están deprecadas en Fly y no admiten máquinas nuevas |
| Máquinas | **1** (`84ed452a4e5338`, `fly deploy --ha=false`): una cola serializada por clave admin |
| Imagen | `registry.fly.io/raiz-relayer:deployment-01M1W2H4TCVRW99YF95BARFNSA` (67 MB, Dockerfile del repo, commit `main` del 6-sep) |
| Secrets (solo nombres) | `NETWORK`, `RELAYER_ADMIN_SECRET`, `RELAYER_APP_KEY` — cargados con `fly secrets import` por stdin, nunca escritos a disco |
| Check de Fly | `GET /v1/live` cada 30 s → 1/1 passing |

## Smoke real tras el deploy (2026-09-06 19:19 UTC)

| Comprobación | Resultado |
|---|---|
| `GET /v1/live` | `200 {"ok":true,"uptimeSeconds":31}` |
| `GET /v1/health` | `200`, `network=testnet`, `protocolVersion=28`, `admin=GBLS7PL5…`, los 6 contratos = `deployments.json`, `faucet.enabled=true` |
| `POST /v1/faucet` sin `x-raiz-app-key` | `401 UNAUTHORIZED_APP` |
| `POST /v1/faucet` a `GC4ASV6WOCUWUZAAFWG4TOU7XXYUCRJDLT6YJ2CZCJRF77QN42LNADTB` (G… nueva con trustline) | `200`, `method=payment`, **tx `d8eee5faa0a7f710151c9dc9b6933ca59a67ff8367f2ee2a637ade15182419af`** (ledger 4539759) → https://stellar.expert/explorer/testnet/tx/d8eee5faa0a7f710151c9dc9b6933ca59a67ff8367f2ee2a637ade15182419af |
| Horizon | tx `successful=true`, `source_account=GBLS7PL5…` (admin firmando server-side); balance USDC del destino = `20.0000000` |
| `POST /v1/faucet` repetido a la misma address | `429 RATE_LIMITED`, header `Retry-After: 565`, `details.retryAfterSeconds=565` |
| `POST /v1/mint-resident` con `barrioId` inexistente | `404 BARRIO_ADMIN_NOT_SET`, `details.contract=governance`, `contractCode=4` (atribución al contrato que falló) |
| `fly logs` | 0 cadenas con forma de seed (`S[A-Z0-9]{55}`); solo eventos `submit`/`send`/`poll` con `txHash` |

Nota operativa: `curl` de Windows (schannel) falla a veces el handshake TLS contra la IPv4
compartida de Fly ("failed to receive handshake"); Node `fetch`, la app Android y `curl` en
Linux no lo sufren. Reintentar la llamada basta.

## Reproducir el deploy

```bash
fly apps create raiz-relayer --org personal
python secrets_lines.py | fly secrets import -a raiz-relayer   # NETWORK, RELAYER_ADMIN_SECRET, RELAYER_APP_KEY
fly deploy --ha=false -a raiz-relayer                          # UNA máquina
fly status -a raiz-relayer                                     # 1 machine, checks passing
```
