/**
 * Autenticación de la app: API key estática en la cabecera `x-raiz-app-key`.
 *
 * Es un limitador de abuso, no una autenticación fuerte: la key viaja en el
 * APK y es extraíble (documentado en el README). Aun así se compara en tiempo
 * constante sobre hashes sha256 (longitudes iguales → `timingSafeEqual` no
 * lanza y no filtra la longitud de la key real).
 *
 * Se aplica como preHandler a todos los POST; `GET /v1/health` es público.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { preHandlerAsyncHookHandler } from "fastify";
import { RelayerError } from "./errors.js";

export const APP_KEY_HEADER = "x-raiz-app-key";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function makeAuthHook(appKey: string): preHandlerAsyncHookHandler {
  const expected = sha256(appKey);
  return async function authHook(req) {
    const raw = req.headers[APP_KEY_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    const ok = typeof provided === "string" && provided.length > 0 && timingSafeEqual(sha256(provided), expected);
    if (!ok) {
      /* Mismo mensaje para "falta" e "incorrecta": no damos pistas. */
      throw new RelayerError("UNAUTHORIZED_APP", "Falta o es incorrecta la cabecera x-raiz-app-key.");
    }
  };
}
