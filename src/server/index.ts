import { buildApp } from "./app.js";
import { resolvePort } from "./config.js";
let runtimeOrigin = `http://127.0.0.1:${process.env.MIRACLE_RUNTIME_PORT || resolvePort()}`;
const app = await buildApp({
  runtimeOrigin: process.env.MIRACLE_CONTROL_TOKEN
    ? () => runtimeOrigin
    : undefined,
  projectRoot: process.env.MIRACLE_PROJECT_ROOT || process.cwd(),
  instanceId: process.env.MIRACLE_INSTANCE_ID,
  logger: true,
  controlToken: process.env.MIRACLE_CONTROL_TOKEN,
  onShutdown: () => {
    process.exitCode = 0;
  },
});
try {
  runtimeOrigin = await app.listen({
    port: process.env.MIRACLE_RUNTIME_PORT === "0" ? 0 : resolvePort(),
    host: "127.0.0.1",
  });
  process.send?.({
    type: "miracle-ready",
    port: Number(new URL(runtimeOrigin).port),
    instanceId: process.env.MIRACLE_INSTANCE_ID,
  });
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
