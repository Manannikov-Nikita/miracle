# Beta release channel

The user wants to publish the DuckDB release as a beta, excluded from the default stable release, and explicitly chose to update the current installation rather than install a second application.

Publish `0.12.0-beta.1` as GitHub prerelease with `latest=false`. Keep the immutable stable `v0.11.0` assets and default branch unchanged. The beta's versioned `install.sh` requires `--beta` before doing any work. The existing stable installer cannot interpret this new flag; documentation must use the beta asset URL for first installation.

Support numbered `X.Y.Z-beta.N` versions throughout packaging, installed launcher and comparison. Stable X.Y.Z ranks above its beta; downgrades remain prohibited. `miracle update` selects stable only; `miracle update --beta` explicitly permits published beta versions, alongside stable releases. `--to` targeting a beta also requires `--beta`. Beta consent is per command, not persisted as a default channel.

Approaches: a prerelease alone would isolate GitHub latest but give no explicit installer opt-in; replacing the stable installer would mutate an existing release. Use a guarded, versioned beta installer instead. This is the implementation choice supporting the user's requested flag and current-installation behavior.

Opening a workspace in this beta upgrades SQLite to schema 9. Document a pre-beta backup for returning to 0.11.0; do not imply a binary downgrade can undo a schema migration.

Release checks must cover stable channel isolation, beta opt-in and version ordering, existing installation preservation on rejection/failure, all native packages and offline XLSX, public beta download, and unchanged latest stable after publication.
