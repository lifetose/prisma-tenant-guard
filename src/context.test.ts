import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { TenantStore } from "./context.js";
import { TenantContextMissingError } from "./errors.js";

describe("TenantStore", () => {
  it("reads back the scopes it was run with", () => {
    const store = new TenantStore<"venue">();

    expect(store.run({ venue: "v1" }, () => store.get("venue"))).toBe("v1");
  });

  it("has no scopes outside a run", () => {
    const store = new TenantStore<"venue">();

    expect(store.current()).toBeUndefined();
    expect(store.get("venue")).toBeUndefined();
  });

  it("copies the scopes so a later mutation cannot reach into the store", () => {
    const store = new TenantStore<"venue">();
    const scopes = { venue: "v1" };

    store.run(scopes, () => {
      scopes.venue = "v2";
      expect(store.get("venue")).toBe("v1");
    });
  });

  it("keeps the context across an await", async () => {
    const store = new TenantStore<"venue">();

    await store.run({ venue: "v1" }, async () => {
      await delay(1);
      expect(store.get("venue")).toBe("v1");
    });
  });

  it("keeps concurrent runs apart", async () => {
    const store = new TenantStore<"venue">();

    const read = async (
      venue: string,
      wait: number,
    ): Promise<string | undefined> =>
      await store.run({ venue }, async () => {
        await delay(wait);
        return store.get("venue");
      });

    await expect(Promise.all([read("v1", 5), read("v2", 1)])).resolves.toEqual([
      "v1",
      "v2",
    ]);
  });

  it("names the column when a required scope is missing", () => {
    const store = new TenantStore<"venue">((scope) =>
      scope === "venue" ? "venueId" : undefined,
    );

    expect(() => store.run({}, () => store.require("venue"))).toThrow(
      TenantContextMissingError,
    );
    expect(() => store.run({}, () => store.require("venue"))).toThrow(
      /venueId/,
    );
  });

  it("patches the running context", () => {
    const store = new TenantStore<"venue" | "organization">();

    store.run({ organization: "o1" }, () => {
      store.assign({ venue: "v1" });
      expect(store.current()).toEqual({ organization: "o1", venue: "v1" });
    });
  });

  it("ignores a patch made outside a run", () => {
    const store = new TenantStore<"venue">();

    expect(() => store.assign({ venue: "v1" })).not.toThrow();
    expect(store.current()).toBeUndefined();
  });

  it("drops the context inside exit", () => {
    const store = new TenantStore<"venue">();

    store.run({ venue: "v1" }, () => {
      expect(store.exit(() => store.current())).toBeUndefined();
      expect(store.get("venue")).toBe("v1");
    });
  });
});

describe("a context that carries more than scopes", () => {
  interface Session {
    userId: string;
    isPlatformAdmin: boolean;
  }

  it("reads back the extra fields", () => {
    const store = new TenantStore<"venue", Session>();

    store.run({ venue: "v1", userId: "u1", isPlatformAdmin: true }, () => {
      expect(store.current()).toEqual({
        venue: "v1",
        userId: "u1",
        isPlatformAdmin: true,
      });
    });
  });

  it("still reads a scope through get", () => {
    const store = new TenantStore<"venue", Session>();

    expect(
      store.run({ venue: "v1", userId: "u1" }, () => store.get("venue")),
    ).toBe("v1");
  });

  it("patches an extra field into a running context", () => {
    const store = new TenantStore<"venue", Session>();

    store.run({ venue: "v1" }, () => {
      store.assign({ userId: "u1" });
      expect(store.current()?.userId).toBe("u1");
    });
  });
});
