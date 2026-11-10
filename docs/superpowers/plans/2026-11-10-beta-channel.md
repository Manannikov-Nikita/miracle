# Beta Channel Implementation Plan

> **For agentic workers:** use superpowers:subagent-driven-development for the independent implementation tasks, then one integrated review.

**Goal:** Publish 0.12.0-beta.1 with explicit installation consent while preserving stable 0.11.0.

**Architecture:** Versioned GitHub prerelease assets; guarded shell bootstrap and shared version ordering semantics in installer/updater; existing native release CI.

**Tech Stack:** Node 24.22.2, TypeScript, POSIX shell, GitHub Actions/releases.

**Spec:** `docs/superpowers/specs/2026-11-10-beta-channel-design.md`

## Global constraints

- Beta updates the current installation; explicit `--beta` is required per command.
- Versions are X.Y.Z or X.Y.Z-beta.N, N positive; safe integers, no leading zeroes. Stable outranks beta for the same base.
- Do not modify stable release assets or merge into the default branch to publish beta.
- Preserve downgrade prevention, checksums, process locks, data and custom launcher paths.

## Review focus

- An old stable installer ignores unknown arguments: first-beta instructions must point to its versioned asset.
- Unsafe/malformed versions must not reach filesystem paths or generated launcher execution.
- Opt-in failure must occur before download or changes to an existing installation.
- Stable update from an installed beta must not downgrade; future stable of the same base must be accepted.
- CI upgrade fixtures run old stable CLIs: first beta upgrade must exercise its flagged bootstrap.

## Task 1: Installer and installed upgrade checks

- [ ] Add failing tests for beta guard, safe numbered versions and downgrade ordering.
- [ ] Modify `release/install.sh`, `release/install.mjs`, generated launcher, and their tests.
- [ ] Update native install/upgrade smoke harnesses to pass explicit beta consent and preserve stable fixture behavior; run focused tests.

## Task 2: Updater opt-in

- [ ] Add tests for parseUpdateArguments, stable/default filtering, `--beta`, explicit beta `--to`, safe ordering and failures.
- [ ] Implement in `src/server/update.ts`, update CLI help. For beta downloads pass `--beta` to installer; stable call contract remains compatible.
- [ ] Run `tests/local-update.test.ts` and typecheck.

## Task 3: Packaging, publication and docs

- [ ] Root updates manifests to 0.12.0-beta.1, build/publish version validation, release workflow and notes; stub-test publish prerelease/latest flags.
- [ ] Document beta install/update and backup before schema migration; run full tests, typecheck/build and independent review.
- [ ] Commit/push beta branch and tag after local gates; wait for native CI and publication.
- [ ] Verify public assets/checksums, install through published beta URL, test beta query/update behavior, and confirm latest remains v0.11.0.
