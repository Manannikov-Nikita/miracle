import { describe, expect, it } from "vitest";
import { parseTrinoJdbcUrl } from "../src/shared/trino-url.js";

describe("Trino JDBC import", () => {
  it("imports browser authentication with FULL TLS and memory-only caching", () => {
    expect(
      parseTrinoJdbcUrl(
        "jdbc:trino://trino.example:443?SSL=true&SSLVerification=FULL&externalAuthentication=true&externalAuthenticationTokenCache=MEMORY",
      ),
    ).toEqual({
      url: "https://trino.example",
      externalAuthentication: true,
    });
  });

  it("extracts catalog, schema and credentials without retaining the query string", () => {
    expect(
      parseTrinoJdbcUrl(
        "jdbc:trino://trino.example:8443/hive/sales%20data?SSL=true&user=alice&password=p%40ss%2Bword",
      ),
    ).toEqual({
      url: "https://trino.example:8443",
      catalog: "hive",
      schema: "sales data",
      username: "alice",
      password: "p@ss+word",
      externalAuthentication: false,
    });
  });

  it("supports plain HTTP and IPv6 when external authentication is disabled", () => {
    expect(parseTrinoJdbcUrl("jdbc:trino://[::1]:8080?SSL=false")).toEqual({
      url: "http://[::1]:8080",
      externalAuthentication: false,
    });
  });

  it("preserves port 80 when HTTPS is explicitly requested", () => {
    expect(parseTrinoJdbcUrl("jdbc:trino://host:80?SSL=true").url).toBe(
      "https://host:80",
    );
  });

  it.each([
    "jdbc:trino://host?SSL=true&SSLVerification=NONE",
    "jdbc:trino://host?SSL=true&SSLVerification=CA",
    "jdbc:trino://host?SSL=true&externalAuthentication=true&externalAuthenticationTokenCache=DISK",
    "jdbc:trino://host?externalAuthentication=true",
    "jdbc:trino://host?SSL=true&SSL=false",
    "jdbc:trino://host?SSL=yes",
    "jdbc:trino://host?externalAuthentication=maybe",
    "jdbc:trino://host?accessToken=secret",
    "jdbc:trino://host?SSLTrustStorePath=secret",
    "jdbc:trino://user:secret@host",
    "jdbc:trino://host#secret",
    "jdbc:trino://host/a/b/c",
    "jdbc:trino://host/a/../b",
    "jdbc:trino://host/a/%2e%2e/b",
    "jdbc:trino://host/a/%ZZ",
    "jdbc:trino://host/a/%00",
    "jdbc:trino://host/a%2Fb",
    "https://host",
  ])("rejects unsupported or malformed settings: %s", (value) => {
    expect(() => parseTrinoJdbcUrl(value)).toThrow();
  });

  it("does not echo credentials or unknown parameter names into errors", () => {
    for (const input of [
      "jdbc:trino://host?PRIVATE_SECRET=SECRET_VALUE",
      "jdbc:trino://user:SECRET_VALUE@host",
    ]) {
      try {
        parseTrinoJdbcUrl(input);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(String(error)).not.toMatch(/PRIVATE_SECRET|SECRET_VALUE/);
      }
    }
  });
});
