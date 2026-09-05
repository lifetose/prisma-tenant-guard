import { describe, expect, it } from "vitest";

import { quoteIdentifier, quoteLiteral, toSnakeCase } from "./naming.js";

describe("quoteIdentifier", () => {
  it("quotes a name so postgres keeps its case", () => {
    expect(quoteIdentifier("Order")).toBe('"Order"');
  });

  it("doubles an embedded quote rather than letting it close the name", () => {
    expect(quoteIdentifier('a"; DROP TABLE users; --')).toBe(
      '"a""; DROP TABLE users; --"',
    );
  });
});

describe("quoteLiteral", () => {
  it("doubles an embedded apostrophe", () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("closes off an injected literal", () => {
    expect(quoteLiteral("x'; DROP TABLE users; --")).toBe(
      "'x''; DROP TABLE users; --'",
    );
  });
});

describe("toSnakeCase", () => {
  it("splits camel case", () => {
    expect(toSnakeCase("organizationId")).toBe("organization_id");
  });

  it("splits an acronym from the word after it", () => {
    expect(toSnakeCase("HTTPServer")).toBe("http_server");
  });

  it("leaves an already snake name alone", () => {
    expect(toSnakeCase("order_line")).toBe("order_line");
  });
});
