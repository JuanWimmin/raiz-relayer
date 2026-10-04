# Rotación de la clave del admin — 2026-10-04

Registro de lo que se ejecutó en testnet al rotar la clave con la que se firma por la cuenta admin
(`GBLS7PL5Y65DHQIPMJO6HVQLX4FXEEHQDWHGSBUTGT4V6ZV2IOACYC2P`). El procedimiento general está en el
[runbook del README](../../README.md#runbook-rotación-de-la-clave-del-admin).

**Motivo.** La clave maestra de la cuenta admin iba embebida en el APK 0.1.0 de la app (junio de
2026), que seguía siendo descargable. El redeploy de contratos del 31-jul reutilizó la misma cuenta,
así que la clave nunca se había cambiado.

**Resultado.** La cuenta admin conserva su dirección. Su clave maestra tiene peso 0 y el relayer
firma con un firmante nuevo, `GB42NCO6VSK3ET32J5VHEPDH3GWLX5D5ADCIDQIHJFBY74LMHWMBRYL7`, que nunca
estuvo en un APK ni en un repositorio.

| # | Hora (UTC) | Paso | Evidencia |
|---|---|---|---|
| 1 | 20:50:07 | `set_options`: añadir el firmante nuevo con peso 1. Firma la clave maestra (todavía válida) | tx [`b7524190…3ca1`](https://stellar.expert/explorer/testnet/tx/b7524190400b7a172b336480b08c976d2ea83323e1a611af2f5c38534ec93ca1), ledger 5024684 |
| 2 | 21:14:19 | Despliegue del relayer 0.2.0 en Fly con `RELAYER_ADMIN_SECRET` = la clave nueva (secret por stdin, `fly secrets import --stage` + `fly deploy --ha=false`) | `/v1/health` → `signer: GB42NCO6…`, `signerAuthorized: true`, `version: 0.2.0` |
| 3 | 21:14–21:15 | Faucet real firmado por la clave nueva: pago clásico a una `G…` y `transfer` del SAC a una `C…` | tx [`b3092c56…7189`](https://stellar.expert/explorer/testnet/tx/b3092c56bd9db1b0417b4b3d0a51b1d311d3b4887b32f5e193b92f8fc8197189) (ledger 5024983) y [`04d0a525…7ad4`](https://stellar.expert/explorer/testnet/tx/04d0a5253118f9d2abe886a76392d2c1d7ab85d5ec829a9ee8b4c8d7b75f7ad4) (ledger 5024984) |
| 4 | 21:15:42 | `set_options`: clave maestra a peso 0 y umbrales 1/1/1. Firma la clave **nueva** | tx [`1c56d1ca…35d7`](https://stellar.expert/explorer/testnet/tx/1c56d1ca0c10caaedfeeeccdbca49ce4587500fe76727e868b4c06b4a6b235d7), ledger 5024991 |
| 5 | 21:16 | Una transacción firmada con la clave vieja es rechazada | `stellar tx new bump-sequence --source-account raiz-admin …` → `transaction submission failed: TxBadAuth` |
| 6 | 21:16 | El relayer sigue firmando tras el cambio | faucet tx [`8c868f29…0bca`](https://stellar.expert/explorer/testnet/tx/8c868f2917dba386738f9f4901f46c12e203e87d704b92230d0eee07f2d00bca), ledger 5024999 |

En los pasos 3 y 6 la cuenta de origen de cada transacción es la cuenta admin y la única firma del
sobre lleva la pista (`hint`) de la clave nueva (`6c3d9818`), no la de la maestra (`ba43802c`).

Estado de la cuenta después (Horizon, `/accounts/GBLS7PL5…`):

```json
{
  "thresholds": { "low_threshold": 1, "med_threshold": 1, "high_threshold": 1 },
  "signers": [
    { "key": "GB42NCO6VSK3ET32J5VHEPDH3GWLX5D5ADCIDQIHJFBY74LMHWMBRYL7", "weight": 1 },
    { "key": "GBLS7PL5Y65DHQIPMJO6HVQLX4FXEEHQDWHGSBUTGT4V6ZV2IOACYC2P", "weight": 0 }
  ]
}
```

Notas:

- El paso 4 lo firma la clave nueva a propósito: si no hubiera podido firmar por la cuenta, la
  transacción habría fallado sin cambiar nada.
- La clave nueva vive en los secrets de Fly y en la identidad local `raiz-admin-signer` de quien
  mantiene el servicio. Si se perdiera, no habría forma de firmar por la cuenta admin.
- La rotación corta el acceso de aquí en adelante; no deshace lo que se hubiera firmado con la clave
  vieja mientras fue válida. El historial de la cuenta es público.
- Sigue habiendo un solo firmante. El paso a multisig está preparado en el monorepo
  (`scripts/setup_admin_multisig.sh`).
