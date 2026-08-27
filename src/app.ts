/**
 * Construcción de la app Fastify: plugins, hooks, rutas, manejo de errores.
 *
 * La capa HTTP solo conoce `StellarService` (src/types.ts); en tests se
 * inyecta un servicio falso. Todo error sale con el envelope
 * `{ ok:false, error:{ code, message, retryable, details? } }` — también los
 * que genera el propio Fastify (404, 413, JSON malformado) y el plugin de
 * rate-limit por IP.
 *
 * Flujo común de las rutas POST (`relay`):
 *   parseBody → [idempotencia] → check cupos (429 temprano, sin consumir)
 *   → service.X(input, { afterPreflight }) → 200 { ok:true, txHash, ledger, … }
 * El cupo se consume en `afterPreflight`: tras las validaciones/lecturas del
 * servicio y justo antes de encolar el submit. Así un 400/404/422 no quema
 * cupo, y un submit que sale (aunque acabe en TX_TIMEOUT) sí.
 */
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerAsyncHookHandler,
} from "fastify";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { makeAuthHook } from "./auth.js";
import type { Config } from "./config.js";
import { RelayerError, isRelayerError } from "./errors.js";
import { IdempotencyCache, hashBody } from "./idempotency.js";
import type { Logger } from "./logger.js";
import { makeLimits, type LimitHandle, type Limits } from "./rateLimit.js";
import { registerFaucetRoute } from "./routes/faucet.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerMintResidentRoute } from "./routes/mintResident.js";
import { registerRegisterMerchantRoute } from "./routes/registerMerchant.js";
import { registerVaultRoutes } from "./routes/vault.js";
import type { ServiceHooks, StellarService } from "./types.js";

export const BODY_LIMIT_BYTES = 8192;
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEY_MAX_CHARS = 64;
/** Cabecera que fly-proxy escribe con la IP real del cliente (el cliente no puede fijarla desde fuera). */
export const CLIENT_IP_HEADER = "fly-client-ip";

/**
 * `trustProxy` como FUNCIÓN: solo se confía en el proxy de Fly (red privada
 * 6PN, `fdaa::/16`) y en loopback (local / Docker / tests).
 *
 * Con `trustProxy: true` Fastify confiaba en TODOS los saltos y `req.ip`
 * acababa siendo la entrada MÁS A LA IZQUIERDA de `X-Forwarded-For`, que la
 * escribe el cliente (Fly solo APPENDEA la real al final). Resultado: el log
 * (`remoteAddress` del serializer de pino) quedaba envenenado y cualquiera
 * podía evadir el limitador por IP rotando el header. Un `trustProxy`
 * numérico (hop count) tampoco sirve: Fastify 5 (`lib/request.js`,
 * `getTrustProxyFn`) lo compila a `() => false` porque no puede validar al
 * peer inmediato. Con esta función, `req.ip` = primer salto NO confiable
 * empezando por el socket, es decir, la IP que Fly añadió al final.
 */
export function isTrustedProxy(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("fdaa:") || addr.startsWith("::ffff:127.");
}

/**
 * Clave del limitador por IP: `Fly-Client-IP` (la escribe fly-proxy en cada
 * request; no depende de `X-Forwarded-For`, que el cliente puede rellenar) y,
 * si no viene (local, tests), la IP del socket. Se normaliza igual que hace
 * el keyGenerator por defecto del plugin (IPv6 agrupado por /64) para que un
 * cliente IPv6 no tenga 2^64 cubos gratis.
 */
export function clientIpKey(req: FastifyRequest): string {
  const raw = req.headers[CLIENT_IP_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const ip = (header && header.trim()) || req.socket.remoteAddress || "unknown";
  try {
    return normalizeIP(ip);
  } catch {
    return ip;
  }
}

export interface AppDeps {
  config: Config;
  service: StellarService;
  logger: Logger;
}

export interface RelayOptions<T> {
  /** Ámbito de la idempotencia (= nombre de la ruta). */
  scope: string;
  /** Cupos que la request debe respetar; se consumen todos en `afterPreflight`. */
  limits: LimitHandle[];
  /** Llamada al servicio con los hooks ya montados. */
  run: (hooks: ServiceHooks) => Promise<T>;
}

/** Lo que cada módulo de rutas recibe por closure (sin decorar la instancia). */
export interface RouteContext {
  config: Config;
  service: StellarService;
  limits: Limits;
  idempotency: IdempotencyCache;
  /** preHandler de autenticación por API key. */
  auth: preHandlerAsyncHookHandler;
  /** Flujo común de los POST (ver cabecera del archivo). */
  relay<T>(req: FastifyRequest, opts: RelayOptions<T>): Promise<T>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, service } = deps;

  const app: FastifyInstance = Fastify({
    /* Fastify 5: `loggerInstance` recibe un pino ya creado (con el redact
     * de logger.ts); `logger` solo acepta opciones. */
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    /* Ver `isTrustedProxy`: nunca `true` (XFF controlable por el cliente). */
    trustProxy: isTrustedProxy,
    /* El log de cada request queda ACTIVADO (es el default). No se pasa
     * `disableRequestLogging: false` porque Fastify 5.12 lo marca deprecado
     * (FSTDEP023) y ensucia los logs con un aviso por instancia. */
  });

  /* Capa por IP, con clave = `Fly-Client-IP` (ver `clientIpKey`). El plugin
   * LANZA lo que devuelva errorResponseBuilder, así que devolvemos un
   * RelayerError y el setErrorHandler lo serializa como cualquier otro. */
  await app.register(rateLimit, {
    max: config.rates.perIpPerMinute,
    timeWindow: "1 minute",
    keyGenerator: clientIpKey,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    errorResponseBuilder: (_req, ctx) =>
      new RelayerError("RATE_LIMITED", "Demasiadas requests desde esta IP. Reintenta en un momento.", {
        retryAfterSeconds: Math.max(1, Math.ceil(ctx.ttl / 1000)),
      }),
  });

  const limits = makeLimits(config);
  const idempotency = new IdempotencyCache({ ttlMs: config.idempotencyTtlMs });
  const ctx: RouteContext = {
    config,
    service,
    limits,
    idempotency,
    auth: makeAuthHook(config.appKey),
    relay: (req, opts) => relay(idempotency, req, opts),
  };

  app.setErrorHandler((err: unknown, req, reply) => {
    if (isRelayerError(err)) return sendRelayerError(reply, err);

    const fe = err as { code?: unknown; statusCode?: unknown; message?: unknown } | null;
    const status = typeof fe?.statusCode === "number" ? fe.statusCode : 500;
    const fastifyCode = typeof fe?.code === "string" ? fe.code : "unknown";

    if (status === 413) {
      return sendRelayerError(
        reply,
        new RelayerError("PAYLOAD_TOO_LARGE", `El body supera el máximo de ${BODY_LIMIT_BYTES} bytes.`),
      );
    }
    if (status === 415) {
      return sendRelayerError(
        reply,
        new RelayerError("VALIDATION_ERROR", "Content-Type no soportado: envía application/json.", { fastifyCode }),
      );
    }
    if (status === 400) {
      /* FST_ERR_CTP_INVALID_JSON_BODY, FST_ERR_CTP_EMPTY_JSON_BODY, … */
      return sendRelayerError(
        reply,
        new RelayerError("VALIDATION_ERROR", "Body inválido: se esperaba JSON bien formado.", { fastifyCode }),
      );
    }
    if (status === 429) {
      return sendRelayerError(
        reply,
        new RelayerError("RATE_LIMITED", "Demasiadas requests. Reintenta en un momento.", { retryAfterSeconds: 60 }),
      );
    }
    /* Resto: 500 con mensaje genérico; el detalle (stack incluido) va al log. */
    req.log.error({ err, fastifyCode }, "error no controlado en la request");
    return sendRelayerError(reply, new RelayerError("INTERNAL", "Error interno del relayer."));
  });

  /* El handler 404 NO pasa por el limitador global del plugin (documentado en
   * @fastify/rate-limit): hay que engancharlo a mano como preHandler, si no
   * cualquier ruta inexistente es tráfico ilimitado. Cada 404 cuenta en el
   * mismo cubo por IP que el resto de rutas. */
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) =>
    sendRelayerError(reply, new RelayerError("NOT_FOUND", "Ruta no encontrada.", { method: req.method })),
  );

  registerHealthRoute(app, ctx);
  registerRegisterMerchantRoute(app, ctx);
  registerMintResidentRoute(app, ctx);
  registerFaucetRoute(app, ctx);
  registerVaultRoutes(app, ctx);

  return app;
}

/** Serializa un RelayerError con su HTTP status (+ Retry-After en los 429). */
export function sendRelayerError(reply: FastifyReply, err: RelayerError): FastifyReply {
  if (err.code === "RATE_LIMITED") {
    const seconds = err.details?.retryAfterSeconds;
    if (typeof seconds === "number") reply.header("retry-after", String(seconds));
  }
  return reply.status(err.http).send(err.toBody());
}

function rateLimited(handle: LimitHandle, retryAfterMs: number): RelayerError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new RelayerError(
    "RATE_LIMITED",
    `Cupo agotado (${handle.name}). Reintenta en ${retryAfterSeconds} s.`,
    { limit: handle.name, retryAfterSeconds },
  );
}

/** Lee `idempotency-key`; undefined si no viene; 400 si excede el máximo. */
function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined || key.length === 0) return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new RelayerError(
      "VALIDATION_ERROR",
      `La cabecera ${IDEMPOTENCY_HEADER} debe tener como máximo ${IDEMPOTENCY_KEY_MAX_CHARS} caracteres.`,
    );
  }
  return key;
}

async function relay<T>(idempotency: IdempotencyCache, req: FastifyRequest, opts: RelayOptions<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    /* 429 temprano: sin tocar la red y sin consumir. */
    for (const handle of opts.limits) {
      const decision = handle.check();
      if (!decision.allowed) throw rateLimited(handle, decision.retryAfterMs);
    }
    return opts.run({
      afterPreflight: () => {
        /* Todo o nada: se re-chequean todos antes de consumir ninguno (esto es
         * síncrono, así que dos requests no pueden intercalarse aquí). */
        for (const handle of opts.limits) {
          const decision = handle.check();
          if (!decision.allowed) throw rateLimited(handle, decision.retryAfterMs);
        }
        for (const handle of opts.limits) {
          const decision = handle.consume();
          if (!decision.allowed) throw rateLimited(handle, decision.retryAfterMs);
        }
      },
    });
  };

  /* La idempotencia envuelve TODO el flujo (incluido el check de cupos): una
   * repetición con la misma key devuelve la misma respuesta aunque el cupo
   * por address ya se haya consumido con la primera. */
  const key = idempotencyKeyOf(req);
  if (key === undefined) return execute();
  return idempotency.run(opts.scope, key, hashBody(req.body), execute);
}
