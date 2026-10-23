import { buildApp } from "./app.js";
const app = await buildApp({
  logger: true,
  onLockLost: () => {
    process.exitCode = 1;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
  },
});
await app.listen({
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
