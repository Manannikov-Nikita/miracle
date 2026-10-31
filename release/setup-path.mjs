import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isatty } from "node:tty";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const fishQuote = (value) =>
  "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";

function confirmTerminal(question) {
  let fd;
  try {
    // stdin may contain the installer itself (curl | sh). Only the controlling
    // terminal can provide consent; pipes and redirected input are never read.
    fd = openSync("/dev/tty", "r+");
    if (!isatty(fd)) return false;
    writeSync(fd, `${question} [y/N] `);
    const bytes = [],
      buffer = Buffer.alloc(1);
    while (bytes.length < 4096 && readSync(fd, buffer, 0, 1, null)) {
      if (buffer[0] === 10 || buffer[0] === 13) break;
      bytes.push(buffer[0]);
    }
    return /^(y|yes|д|да)$/i.test(Buffer.from(bytes).toString("utf8").trim());
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function exists(file) {
  return stat(file).then(
    () => true,
    (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
  );
}

export async function setupPath(bin) {
  const env = process.env;
  const alreadyInPath = (env.PATH || "")
    .split(":")
    .some((entry) => resolve(entry) === bin);
  if (alreadyInPath && env.MIRACLE_MODIFY_PATH !== "yes") return;

  const home = homedir();
  const shell = basename(env.SHELL || "");
  const fish = shell === "fish";
  const command = fish
    ? `set -gx PATH ${fishQuote(bin)} $PATH`
    : `export PATH=${quote(bin)}"\${PATH:+:$PATH}"`;
  console.log(
    alreadyInPath
      ? `\nSaving Miracle PATH setup for future terminals: ${bin}`
      : `\nThe Miracle command directory is not in PATH: ${bin}`,
  );
  console.log(
    `Or run Miracle by its full path:\n  ${fish ? fishQuote(join(bin, "miracle")) : quote(join(bin, "miracle"))} start`,
  );
  // PATH entries cannot represent a colon. Avoid generating ambiguous or
  // multiline shell commands for unusual installation paths.
  if (/[:\r\n]/.test(bin)) {
    console.log(
      "Automatic PATH setup is unavailable for paths containing colons or newlines. Use the full command path.",
    );
    return;
  }
  if (!alreadyInPath) console.log(`For this terminal, run:\n  ${command}`);

  let files;
  switch (shell) {
    case "zsh":
      files = [join(env.ZDOTDIR || home, ".zshrc")];
      break;
    case "bash": {
      const loginFiles = [".bash_profile", ".bash_login", ".profile"].map(
        (name) => join(home, name),
      );
      let login = loginFiles[0];
      for (const file of loginFiles) {
        if (await exists(file)) {
          login = file;
          break;
        }
      }
      // Bash reads different files in login and ordinary interactive terminals.
      // Append directly to the selected login file without changing its sourcing.
      files = [join(home, ".bashrc"), login];
      break;
    }
    case "sh":
    case "dash":
    case "ksh":
      files = [join(home, ".profile")];
      break;
    case "fish":
      files = [
        join(
          env.XDG_CONFIG_HOME || join(home, ".config"),
          "fish/conf.d/miracle-path.fish",
        ),
      ];
      break;
    default:
      console.log(
        "Shell not recognized. Add the command above to your shell's startup configuration manually.",
      );
      return;
  }
  const block = fish
    ? `# Miracle CLI\nif not contains -- ${fishQuote(bin)} $PATH\n    set -gx PATH ${fishQuote(bin)} $PATH\nend\n`
    : `# Miracle CLI\ncase ":\${PATH:-}:" in\n  *:${quote(bin)}:*) ;;\n  *) ${command} ;;\nesac\n`;
  const pending = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text.includes(block)) pending.push({ file, text });
  }
  if (!pending.length) {
    console.log(
      "PATH is already configured. Open a new terminal, or run the command above here.",
    );
    return;
  }

  const mode = env.MIRACLE_MODIFY_PATH || "auto";
  if (!["auto", "yes", "no"].includes(mode)) {
    console.log(
      "MIRACLE_MODIFY_PATH must be auto, yes or no; shell configuration was not changed.",
    );
    return;
  }
  const accepted =
    mode === "yes" ||
    (mode === "auto" &&
      !env.CI &&
      confirmTerminal(
        `Add Miracle to PATH in ${pending.map(({ file }) => file).join(" and ")}?`,
      ));
  if (!accepted) {
    console.log(
      "Shell configuration was not changed. To configure it later, rerun the installer and accept PATH setup.",
    );
    return;
  }
  for (const { file, text } of pending) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      `${text && !text.endsWith("\n") ? "\n" : ""}\n${block}`,
      { mode: 0o600 },
    );
    console.log(`PATH configured in ${file}`);
  }
  console.log(
    "Open a new terminal to use miracle start / miracle stop, or run the command above in this terminal.",
  );
}
