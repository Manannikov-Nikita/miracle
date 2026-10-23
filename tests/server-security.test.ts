import { describe, expect, it } from "vitest";
import { assertReadOnly } from "../src/server/sql.js";
import { SecretBox } from "../src/server/secrets.js";
describe("SQL read-only boundary", () => {
  it.each([
    "SELECT 1",
    "-- hi\nWITH x AS (SELECT ';delete' a) SELECT * FROM x;",
    "SHOW TABLES",
    "EXPLAIN SELECT 1",
    'SELECT "drop" FROM x',
    "SELECT $$;delete$$",
  ])("accepts a single read: %s", (sql) =>
    expect(() => assertReadOnly(sql)).not.toThrow(),
  );
  it.each([
    "SELECT 1; SELECT 2",
    "INSERT INTO x VALUES (1)",
    "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
    "EXPLAIN ANALYZE DELETE FROM x",
    "SELECT * INTO OUTFILE '/tmp/a' FROM x",
    "SELECT 1 FORMAT CSV",
    "SELECT 1 /*",
    "SELECT 1; -- ok\n DROP TABLE x",
  ])("rejects mutation or ambiguity: %s", (sql) =>
    expect(() => assertReadOnly(sql)).toThrow(),
  );
});
describe("connection credentials", () => {
  it("encrypts with independent nonces and authenticates ciphertext", () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const a = box.encrypt("sensitive");
    const b = box.encrypt("sensitive");
    expect(a).not.toContain("sensitive");
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe("sensitive");
    expect(() => box.decrypt(a.slice(0, -2) + "xx")).toThrow();
  });
});
import {normalizeTrinoSql} from '../src/server/sql.js';
describe('Trino statement delimiter normalization',()=>{
  it.each([
    ['SELECT 1;', 'SELECT 1'],
    ['SELECT 1; -- trailing ; comment\n', 'SELECT 1 -- trailing ; comment\n'],
    ['SELECT 1; /* trailing ; /* nested */ comment */', 'SELECT 1 /* trailing ; /* nested */ comment */'],
    ["SELECT ';' AS \"semi;column\";", "SELECT ';' AS \"semi;column\""],
    ["SELECT 'it''s;safe'; -- ;", "SELECT 'it''s;safe' -- ;"],
    ["SELECT 'backslash\\';", "SELECT 'backslash\\'"],
    ["SELECT ';' -- comment ;\n", "SELECT ';' -- comment ;\n"],
    ['SELECT 1 /* ; */', 'SELECT 1 /* ; */'],
  ])('normalizes %s without changing literals or comments',(sql,expected)=>expect(normalizeTrinoSql(sql)).toBe(expected));
  it.each(['SELECT 1; SELECT 2','SELECT 1; /* comment */ DROP TABLE x','SELECT 1;;'])('retains the single-statement boundary: %s',sql=>expect(()=>normalizeTrinoSql(sql)).toThrow());
});
