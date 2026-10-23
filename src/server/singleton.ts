import pg, { type ClientConfig } from "pg";

export const APPLICATION_LOCK = 67432916;
/** A dedicated PostgreSQL session owns the process lifetime lock. */
export async function acquireApplicationLock(
  config: ClientConfig,
  onLost: (error: Error) => void,
) {
  const client = new pg.Client({
    ...config,
    application_name: "miracle-app-lock",
    keepAlive: true,
    connectionTimeoutMillis: 5000,
  });
  let closing = false;
  let lost = false;
  const fail = (error: Error) => {
    if (closing || lost) return;
    lost = true;
    onLost(
      new Error(
        "Application database lock lost; this server is shutting down",
        { cause: error },
      ),
    );
  };
  client.on("error", fail);
  client.on("end", () => fail(new Error("Database session ended")));
  try {
    await client.connect();
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [APPLICATION_LOCK],
    );
    if (!result.rows[0].acquired)
      throw new Error(
        "A Miracle server is already running for this database; stop the other instance first",
      );
  } catch (e) {
    closing = true;
    await client.end().catch(() => {});
    throw e;
  }
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking || closing || lost) return;
    checking = true;
    void client
      .query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=$1 AND classid=0 AND granted) AS held",
        [APPLICATION_LOCK],
      )
      .then((result) => {
        if (!result.rows[0].held)
          fail(new Error("Advisory lock is no longer held"));
      })
      .catch(fail)
      .finally(() => {
        checking = false;
      });
  }, 5000);
  heartbeat.unref();
  return {
    async interruptPreviousRuns() {
      if (closing || lost)
        throw new Error("Application database lock lost during startup");
      // Execute on the session that owns the lock. If ownership is lost,
      // PostgreSQL aborts this statement before another server can own it.
      await client.query(
        "UPDATE query_runs SET status='interrupted',error='Сервер перезапущен во время выполнения',finished_at=now() WHERE status IN ('running','cancelling')",
      );
    },
    async close() {
      closing = true;
      clearInterval(heartbeat);
      // Closing the dedicated session releases its lock even after SQL errors.
      await client.end().catch(() => {});
    },
  };
}
