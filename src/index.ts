/**
 * Bootstrap del relayer.
 *
 * Orden: config (falla rápido y sin stack si está mal) → logger → servicio
 * Stellar → app HTTP → listen. Apagado ordenado en SIGTERM/SIGINT: deja de
 * aceptar conexiones, drena la cola de transacciones y sale con 0. Las DOS
 * fases (cerrar el servidor HTTP + drenar la cola) comparten un único tope
 * de `DRAIN_MAX_MS` = 100 s, por debajo del `kill_timeout = 120` de Fly. Un
 * error no capturado es fatal: mejor reiniciar que seguir firmando en un
 * estado desconocido.
 */
import { buildApp } from "./app.js";
import { ConfigError, loadConfig, redactConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createStellarService } from "./stellar/service.js";

const DRAIN_POLL_MS = 500;
/**
 * Tope TOTAL del apagado (cierre HTTP + drenado de la cola). Debe quedar por
 * debajo de `kill_timeout` (120 s en fly.toml) contando el flush del logger
 * (≤ 1 s) para que Fly nunca nos mate a mitad de un job firmado.
 */
const DRAIN_MAX_MS = 100_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    /* unref: si todo termina antes, el timer no mantiene vivo el proceso. */
    setTimeout(resolve, ms).unref();
  });
}

/** Vacía el buffer de pino antes de salir (con transport pretty es asíncrono). */
function exitAfterFlush(logger: Logger, code: number): void {
  const timer = setTimeout(() => process.exit(code), 1_000);
  try {
    logger.flush(() => {
      clearTimeout(timer);
      process.exit(code);
    });
  } catch {
    clearTimeout(timer);
    process.exit(code);
  }
}

async function main(): Promise<void> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[raiz-relayer] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const { config, adminKeypair } = loaded;

  const pretty = Boolean(process.stdout.isTTY) && process.env.NODE_ENV !== "production";
  const logger = createLogger(config.logLevel, pretty);

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandledRejection: el proceso se reinicia");
    exitAfterFlush(logger, 1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException: el proceso se reinicia");
    exitAfterFlush(logger, 1);
  });

  const service = createStellarService({ config, adminKeypair, logger });
  const app = await buildApp({ config, service, logger });

  await app.listen({ port: config.port, host: config.host });
  logger.info({ config: redactConfig(config) }, `raiz-relayer ${config.version} escuchando en ${config.host}:${config.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "apagado ordenado: dejando de aceptar conexiones");

    /* El deadline se fija ANTES de app.close(): Fastify 5 espera a que
     * terminen las respuestas en vuelo, y esas respuestas esperan a la cola
     * (un job puede tardar hasta JOB_TIMEOUT_MS). Si el tope solo cubriera el
     * bucle de drenado, app.close() podría gastar él solo los 120 s de
     * kill_timeout y Fly nos mataría con un job a medias. */
    const deadline = Date.now() + DRAIN_MAX_MS;
    let httpClosed = false;
    try {
      await Promise.race([
        app.close().then(() => {
          httpClosed = true;
        }),
        sleep(DRAIN_MAX_MS),
      ]);
    } catch (e) {
      logger.error({ err: e }, "error cerrando el servidor HTTP");
    }

    /* Segunda fase con el MISMO deadline: solo lo que app.close() no gastó. */
    while (service.queuePending() > 0 && Date.now() < deadline) {
      logger.info({ pending: service.queuePending() }, "drenando la cola de transacciones");
      await sleep(DRAIN_POLL_MS);
    }
    const left = service.queuePending();
    if (left > 0) logger.warn({ pending: left }, "se agotó el tiempo de drenado; quedan jobs en cola");

    /* Si venció el tope con conexiones aún abiertas (respuestas colgadas de
     * jobs que no terminaron), se cortan a la fuerza: mejor un socket roto
     * en el cliente (reintenta con su idempotency-key) que un SIGKILL. */
    if (!httpClosed) {
      logger.warn("el servidor HTTP no cerró a tiempo; cortando las conexiones abiertas");
      app.server.closeAllConnections();
    }
    logger.info("apagado completo");
    exitAfterFlush(logger, 0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  console.error("[raiz-relayer] error fatal en el arranque:", e);
  process.exit(1);
});
