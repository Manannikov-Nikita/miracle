# Agent command compatibility

Miracle's agent profile contains a base CLI command. Miracle starts that command directly, without a shell, and adds the provider protocol: Codex `app-server`, or Claude Code's bidirectional `stream-json` mode. The provider must be installed and authenticated on the machine running Miracle.

## Supported command forms

Direct executable names, quoted executable paths, leading environment assignments, and executable wrapper scripts remain supported:

```text
codex --model my-model -a on-request -s workspace-write
claude --model sonnet
test-launcher agent claude
MODE=local '/opt/my tools/codex' --model my-model
~/bin/my-codex-wrapper --model my-model
```

Version 0.5.1 also separates common launcher arguments from provider arguments:

```text
npx -y @openai/codex --model my-model
npx --package=@openai/codex -- codex --model my-model
node --no-warnings '/opt/my tools/codex.mjs' --model my-model
node --import /opt/register.mjs /opt/codex.mjs --model my-model
env -u CLAUDECODE node --no-warnings /opt/claude.mjs --model sonnet
```

The supported launcher options are deliberately bounded:

| Launcher         | Options before its entrypoint                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx`            | `-y`, `--yes`, `-n`, `--no`, `--no-install`, `-p PACKAGE`, `--package PACKAGE`, `--package=PACKAGE`, `--`                                                                                    |
| `node`, `nodejs` | `--no-warnings`, `--no-deprecation`, `--enable-source-maps`, `--trace-warnings`; `-r`, `--require`, `--import`, `--loader`, `--experimental-loader`, `-C`, `--conditions` with a value; `--` |
| `env`            | `NAME=value`, `-u NAME`, `--unset NAME`, `--unset=NAME`, `--`; may wrap Node or npx                                                                                                          |

Long options that take values also accept `--option=value`. Home-relative `~/` paths expand for the executable and recognized launcher entrypoint. No variable expansion, aliases, shell functions, pipes, substitutions, or shell startup scripts are evaluated. Native Windows command-line behavior has not been validated by this change; the examples above use POSIX argument quoting.

Unsupported or incomplete launcher syntax produces an error directing the user to an executable wrapper script. Put unusual launcher options inside the script and forward all supplied arguments to the provider, for example:

```sh
#!/bin/sh
exec /opt/provider/bin/codex "$@"
```

The wrapper must support the provider's `--version` and `--help` commands, forward the managed protocol arguments, preserve Miracle's injected MCP environment, and keep stdout free of diagnostic text during structured conversations. `env -i` is unsupported because it discards the environment needed by the provider connection. Miracle also rejects `env -u MIRACLE_*`.

Codex model, approval and sandbox arguments retain their existing configuration mapping. Miracle still owns the working directory, provider subcommand, conversation resume, protocol format and Miracle MCP connection. Provider arguments that conflict with those controls remain rejected. Custom wrapper flags cannot be distinguished from provider flags in the single command field; put those custom settings inside the wrapper script.

## What changed in 0.5.1

A local executable fixture verifies that positional wrapper arguments remain intact during version, help and runtime launches. This verifies Miracle's argv construction, not compatibility with every external launcher or a real provider conversation. A launcher that rejects Claude's managed `stream-json` arguments cannot use the current structured chat. Use a compatible Claude Code CLI directly, or a wrapper that actually forwards the complete provider protocol. Wrapping an incompatible interactive CLI without adding that protocol does not make it compatible.

Capability failures now preserve the sanitized provider error and explain this structured-protocol requirement. Missing required flags no longer suggest that updating the CLI alone necessarily resolves an incompatible wrapper.

Previously, Miracle stopped looking for launcher arguments at the first flag. `node --no-warnings cli.mjs` consequently produced `node app-server --no-warnings cli.mjs` for Codex. Capability checks could run Node's own `--version` and `--help` instead of the provider. Likewise, `npx -y @openai/codex` received `app-server` before the npx options and package name.

The command builder now returns one launcher prefix for both runtime and capability checks. Version checks append `--version` to that prefix; help checks retain the built provider options as well. A real child-process regression verifies both providers with a Node option and a script path containing spaces and Unicode, and checks the argv received during version, help and runtime launches. Package-runner argument ordering is covered without downloading packages or invoking a paid provider.

## What to borrow from Orca

Sources reviewed on 2026-11-04:

- [Supported agents](https://www.onorca.dev/docs/agents/supported): Orca's broad CLI compatibility comes from terminal process launching; deeper integration varies by provider.
- [Native Chat UI](https://www.onorca.dev/docs/agents/native-chat): structured chat is a separate surface for supported providers, with its own command/environment handling. Other sessions can use terminal-backed chat.
- [Structured command resolution](https://github.com/stablyai/orca/blob/main/src/main/native-chat/structured-agent-command-resolution.ts): executable resolution, explicit command overrides, home paths, and retry after shell-environment refresh are separate from provider operation.
- [Launcher argv tests](https://github.com/stablyai/orca/blob/main/src/main/native-chat/chat-launcher-command.test.ts): custom command prefix arguments precede provider-managed arguments, including Codex `app-server`; version probing preserves the prefix.
- [Structured command plan](https://github.com/stablyai/orca/blob/main/src/shared/agent-launch/startup/tui-agent-launch-command-override.ts): native chat uses a literal executable and prefix, with shell syntax rejected.

The useful near-term lesson is to share one launch plan and test the actual subprocess boundary. Miracle keeps its native Codex/Claude adapters in 0.5.1. Orca's terminal support does not imply that arbitrary interactive CLIs can speak Miracle's structured protocol, and its native integrations should not be described as a single ACP transport.

A later release can separate executable, launcher arguments, provider arguments and environment into explicit settings, removing the ambiguity of one command field. Executable discovery and an opt-in login-shell environment refresh can follow if deployment evidence warrants them. Supporting arbitrary interactive launchers that cannot forward the structured protocol requires a separate terminal mode, or a dedicated adapter implementing their supported protocol. That is separate work with session, cancellation and permission requirements; 0.5.1 does not add a terminal mode or claim compatibility with unknown launcher implementations.