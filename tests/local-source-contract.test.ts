import { expect, it } from "vitest";
import { sourceSchema } from "../src/shared/board-schema.js";
import { editorFields } from "../src/server/project-store.js";

it("accepts explicit local SQL without a remote connection", () => {
  expect(sourceSchema.parse({ kind: "local", sql: "select 1" })).toEqual({
    kind: "local",
    sql: "select 1",
  });
});

it("requires a connection for legacy remote SQL and rejects mixed local context", () => {
  expect(sourceSchema.safeParse({ sql: "select 1" }).success).toBe(false);
  expect(
    sourceSchema.safeParse({
      kind: "local",
      sql: "select 1",
      connectionId: "00000000-0000-4000-8000-000000000001",
    }).success,
  ).toBe(false);
  expect(
    sourceSchema.safeParse({
      kind: "local",
      sql: "select 1",
      database: "other",
    }).success,
  ).toBe(false);
  expect(
    sourceSchema.parse({
      connectionId: "00000000-0000-4000-8000-000000000001",
      sql: "select 1",
    }).connectionId,
  ).toBeDefined();
});

it("persists the local editor context without a fabricated connection", () => {
  expect(
    editorFields.parse({ name: "local.sql", sql: "", kind: "local" }),
  ).toEqual({ name: "local.sql", sql: "", kind: "local" });
});
