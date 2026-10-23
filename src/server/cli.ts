import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Pool, migrate, bootstrapAdmin, issueSetupToken } from "./db.js";
import { databaseConfig } from "./config.js";
import { loadKey, SecretBox, verifyEncryptionKey } from "./secrets.js";
async function main() {
  if (process.argv[2] === "setup-link") {
    const db = new Pool(databaseConfig());
    try {
      await migrate(db);
      await verifyEncryptionKey(db, new SecretBox(loadKey()));
      const token = await issueSetupToken(db);
      const origin = (
        process.env.APP_ORIGIN || "http://127.0.0.1:5178"
      ).replace(/\/$/, "");
      console.log(token ? origin + "/#setup=" + token : origin);
    } finally {
      await db.end();
    }
    return;
  }
  if (process.argv[2] !== "bootstrap-admin")
    throw new Error("Usage: bootstrap-admin | setup-link");
  let email = process.env.MIRACLE_ADMIN_EMAIL;
  let name = process.env.MIRACLE_ADMIN_NAME;
  let password = process.env.MIRACLE_ADMIN_PASSWORD;
  if (!email || !password) {
    if (!stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      email = data.email;
      name = data.name;
      password = data.password;
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        email = email || (await rl.question("Email: "));
        name = name || (await rl.question("Имя: "));
        stdout.write("Пароль (не отображается): ");
        rl.close();
        password = await new Promise<string>((resolve, reject) => {
          let value = "";
          stdin.setRawMode(true);
          stdin.resume();
          const handler = (chunk: Buffer) => {
            for (const char of chunk.toString()) {
              if (char === "\r" || char === "\n") {
                stdin.removeListener("data", handler);
                stdin.setRawMode(false);
                stdin.pause();
                stdout.write("\n");
                resolve(value);
                return;
              }
              if (char === "\u0003") {
                stdin.setRawMode(false);
                reject(new Error("Cancelled"));
                return;
              }
              if (char === "\u007f") value = value.slice(0, -1);
              else value += char;
            }
          };
          stdin.on("data", handler);
        });
      } finally {
        rl.close();
      }
    }
  }
  if (!email || !password) throw new Error("Email/password required");
  const db = new Pool(databaseConfig());
  try {
    await migrate(db);
    await bootstrapAdmin(db, email, name || email.split("@")[0]!, password);
    console.log("Administrator created.");
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    e instanceof Error &&
      !/password authentication|connection string/i.test(e.message)
      ? e.message
      : "Database authentication failed; check the original database configuration",
  );
  process.exitCode = 1;
});
