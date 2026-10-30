import { buildApp } from "./app.js";
import { resolvePort } from "./config.js";
const app = await buildApp({
  logger: true,
  controlToken: process.env.MIRACLE_CONTROL_TOKEN,
  onShutdown: () => {
    process.exitCode = 0;
  },
});
try {
  await app.listen({ port: resolvePort(), host: "127.0.0.1" });
} catch (error) {
  await app.close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
