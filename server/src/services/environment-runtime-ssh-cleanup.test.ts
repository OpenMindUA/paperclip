import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { environmentRuntimeService } from "./environment-runtime.js";

const lease = (provider: string | null) => ({
  id: "lease", companyId: "company", provider, providerLeaseId: "ssh://u@h:22/w",
  metadata: { driver: "ssh" },
}) as never;

describe("ssh pending_cleanup teardown", () => {
  const runtime = environmentRuntimeService({} as Db);

  it("accepts an ssh lease: it holds no provider resource to destroy", async () => {
    await expect(runtime.retryPendingSandboxTeardown({ environment: null, lease: lease("ssh") })).resolves.toBeUndefined();
  });

  it("still refuses a lease of another provider that is labelled ssh", async () => {
    await expect(runtime.retryPendingSandboxTeardown({ environment: null, lease: lease("e2b") })).rejects.toThrow(/another provider/);
  });
});
