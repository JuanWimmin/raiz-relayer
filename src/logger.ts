/**
 * Logger estructurado (pino). Redacta cabeceras de autenticación y cualquier
 * campo que huela a secreto. El secret del admin nunca llega aquí (config.ts
 * lo devuelve como Keypair separado), pero el redact es cinturón y tirantes.
 */
import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers["x-raiz-app-key"]',
        "req.headers.authorization",
        "req.headers.cookie",
        "*.secret",
        "*.adminSecret",
        "*.RELAYER_ADMIN_SECRET",
        "*.RELAYER_APP_KEY",
        "*.appKey",
        "*._secretKey",
        "*._secretSeed",
      ],
      censor: "[redactado]",
    },
    base: { service: "raiz-relayer" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
