import { describe, expect, it } from "vitest";

import { defineTenancy } from "../tenancy.js";
import { resetConfigSql, setConfigSql, tenantSettings } from "./settings.js";

const tenancy = defineTenancy({
  scopes: {
    organization: { column: "organizationId" },
    venue: { column: "venueId" },
  },
  models: { Order: "organization", Booking: "venue" },
});

describe("tenantSettings", () => {
  it("reads the scopes the current context actually carries", () => {
    tenancy.run({ organization: "org-1" }, () => {
      expect(tenantSettings(tenancy)).toEqual([
        { scope: "organization", name: "app.organization_id", value: "org-1" },
      ]);
    });
  });

  it("carries every scope that is set", () => {
    tenancy.run({ organization: "org-1", venue: "v-1" }, () => {
      expect(tenantSettings(tenancy).map((s) => s.scope)).toEqual([
        "organization",
        "venue",
      ]);
    });
  });

  it("returns nothing outside a context", () => {
    expect(tenantSettings(tenancy)).toEqual([]);
  });

  it("honours a custom setting name", () => {
    tenancy.run({ organization: "org-1" }, () => {
      expect(
        tenantSettings(tenancy, { settingName: (s) => `t.${s}` })[0]?.name,
      ).toBe("t.organization");
    });
  });
});

describe("setConfigSql", () => {
  it("sets the value for the transaction only", () => {
    expect(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "org-1",
      }),
    ).toBe("SELECT set_config('app.organization_id', 'org-1', true)");
  });

  it("escapes a value that tries to close the literal", () => {
    expect(
      setConfigSql({
        scope: "organization",
        name: "app.organization_id",
        value: "x'; DROP TABLE orders; --",
      }),
    ).toBe(
      "SELECT set_config('app.organization_id', 'x''; DROP TABLE orders; --', true)",
    );
  });
});

describe("resetConfigSql", () => {
  it("clears the setting back to empty", () => {
    expect(resetConfigSql("organization")).toBe(
      "SELECT set_config('app.organization_id', '', true)",
    );
  });
});
