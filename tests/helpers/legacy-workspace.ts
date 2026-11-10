import type { Database } from "../../src/server/db.js";

/** Remove the v9-only schema before a fixture represents an older workspace. */
export function removeDatasetSchema(db: Database) {
  db.sqlite.exec(`
    DROP TABLE board_dataset_history_refs;
    DROP TABLE datasets;
    ALTER TABLE query_runs DROP COLUMN dataset_refresh;
  `);
}
