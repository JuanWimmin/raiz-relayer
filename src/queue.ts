/**
 * Cola serializada: un job a la vez.
 *
 * Todas las transacciones del relayer salen de la MISMA cuenta admin, y una
 * cuenta Stellar solo puede tener una secuencia en vuelo. Dos envíos
 * simultáneos = uno de los dos falla con txBadSeq. En vez de repartir
 * secuencias a mano, encadenamos promesas: el siguiente job no empieza hasta
 * que el anterior termina (éxito, error o timeout).
 *
 * Reglas:
 *  - `cap`: si ya hay `cap` jobs esperando/en curso, rechazamos al instante con
 *    QUEUE_FULL (503 retryable) en lugar de dejar que la latencia crezca sin
 *    límite.
 *  - `jobTimeoutMs`: si un job supera el límite, SU promesa rechaza con
 *    TX_TIMEOUT y la cola sigue con el siguiente. El job "zombi" continúa en
 *    background (no se puede cancelar una petición HTTP a medias); solo
 *    logueamos lo que le pase. submit.ts tiene su propio deadline más corto
 *    (jobDeadlineMs), así que esto es la red de seguridad, no el camino normal.
 *
 * Solo debe existir UNA instancia por proceso y UN proceso por cuenta admin
 * (Fly `--ha=false`); con dos réplicas volveríamos al txBadSeq.
 */
import { RelayerError } from "./errors.js";
import type { Logger } from "./logger.js";

export interface SerialQueueOptions {
  cap: number;
  jobTimeoutMs: number;
  logger?: Logger;
  /** Reloj inyectable (ms). Solo para medir duraciones en los logs. */
  now?: () => number;
}

const noop = (): void => undefined;

export class SerialQueue {
  private readonly cap: number;
  private readonly jobTimeoutMs: number;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  /** Cola de promesas: cada job se encadena al final de la anterior. */
  private tail: Promise<void> = Promise.resolve();
  /** Jobs esperando o en curso (los zombis ya no cuentan). */
  private count = 0;
  private seq = 0;

  constructor(opts: SerialQueueOptions) {
    if (!Number.isInteger(opts.cap) || opts.cap < 1) throw new Error("SerialQueue: cap debe ser un entero >= 1");
    if (!Number.isFinite(opts.jobTimeoutMs) || opts.jobTimeoutMs <= 0) {
      throw new Error("SerialQueue: jobTimeoutMs debe ser > 0");
    }
    this.cap = opts.cap;
    this.jobTimeoutMs = opts.jobTimeoutMs;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  /** Jobs esperando o en curso. */
  pending(): number {
    return this.count;
  }

  /**
   * Lanza el MISMO QUEUE_FULL que `enqueue` si no hay sitio, sin ocupar plaza.
   * Sirve para comprobar la capacidad ANTES de efectos irreversibles del
   * llamador (p. ej. consumir el cupo de rate-limit): como es síncrono, si no
   * lanza, un `enqueue` inmediato en el mismo tick está garantizado.
   */
  assertCapacity(label = "job"): void {
    const full = this.queueFullError(label);
    if (full) throw full;
  }

  /**
   * Encola `fn`. Resuelve/rechaza con lo que devuelva `fn`, o con TX_TIMEOUT si
   * supera `jobTimeoutMs`. Rechaza de inmediato con QUEUE_FULL si no hay sitio.
   */
  enqueue<T>(fn: () => Promise<T>, label = "job"): Promise<T> {
    const full = this.queueFullError(label);
    if (full) return Promise.reject(full);
    this.count += 1;
    const jobId = ++this.seq;
    const run = this.tail.then(() => this.runOne(fn, label, jobId));
    // La cadena nunca se rompe: un fallo o timeout del job no bloquea al siguiente.
    this.tail = run.then(noop, noop).then(() => {
      this.count -= 1;
    });
    return run;
  }

  /** Resuelve cuando no queda ningún job esperando ni en curso (shutdown). */
  async drain(): Promise<void> {
    while (this.count > 0) {
      await this.tail;
    }
  }

  /** Único punto que construye QUEUE_FULL (mensaje y details idénticos en assertCapacity y enqueue). */
  private queueFullError(label: string): RelayerError | undefined {
    if (this.count < this.cap) return undefined;
    this.logger?.warn({ label, pending: this.count, cap: this.cap }, "cola: llena, rechazando job");
    return new RelayerError("QUEUE_FULL", "El relayer está saturado en este momento; reintenta en unos segundos.", {
      pending: this.count,
      cap: this.cap,
    });
  }

  private async runOne<T>(fn: () => Promise<T>, label: string, jobId: number): Promise<T> {
    const startedAt = this.now();
    this.logger?.debug({ label, jobId, pending: this.count }, "cola: job iniciado");

    // `async () => fn()` convierte un throw síncrono de fn en rechazo.
    const job = (async () => fn())();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(
          new RelayerError(
            "TX_TIMEOUT",
            "La operación superó el tiempo máximo del relayer. Puede haberse aplicado on-chain igualmente: comprueba el estado antes de reintentar.",
            { txHash: null },
          ),
        );
      }, this.jobTimeoutMs);
    });

    try {
      const result = await Promise.race([job, timeout]);
      this.logger?.debug({ label, jobId, elapsedMs: this.now() - startedAt }, "cola: job terminado");
      return result;
    } catch (e) {
      if (timedOut) {
        this.logger?.warn(
          { label, jobId, elapsedMs: this.now() - startedAt, timeoutMs: this.jobTimeoutMs },
          "cola: job superó el timeout; la cola continúa y el job queda en background",
        );
        // El zombi sigue vivo: registramos su desenlace y evitamos un unhandledRejection.
        void job.then(
          () => this.logger?.warn({ label, jobId }, "cola: job zombi terminó con éxito tras el timeout"),
          (err: unknown) =>
            this.logger?.warn({ label, jobId, err: errorMessage(err) }, "cola: job zombi falló tras el timeout"),
        );
      } else {
        this.logger?.debug(
          { label, jobId, elapsedMs: this.now() - startedAt, err: errorMessage(e) },
          "cola: job falló",
        );
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
