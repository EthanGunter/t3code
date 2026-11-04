import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only schema, kept out of the numbered migrator: any fork id there can mask a future
// upstream migration. See docs/internals/legacy-orchestration-migration.md.
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("check_json")) yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN check_json TEXT`;
  if (!names.has("last_check_json"))
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_check_json TEXT`;
});
