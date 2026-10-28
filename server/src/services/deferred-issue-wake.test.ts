import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { findDeferredIssueWake } from "./deferred-issue-wake.js";

const support = await getEmbeddedPostgresTestSupport();

// Agent A hands its issue to agent B with a comment. B's wake meets A's still
// held lock and is parked as `deferred_issue_execution` under B. When A's run
// finishes its cleanup, that wake must be found, although it is not A's.
(support.supported ? describe : describe.skip)("deferred wake of a handed-off issue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("deferred-issue-wake-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deferred", defaultResponsibleUserId: "board",
      issuePrefix: `D${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: {} });
    await db.insert(agents).values([agent(outgoingId, "Builder"), agent(ownerId, "Reviewer")]);
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Handed over", status: "todo", assigneeAgentId: ownerId },
      { id: otherIssueId, companyId, title: "Unrelated", status: "todo", assigneeAgentId: ownerId },
    ]);
    return { companyId, outgoingId, ownerId, issueId, otherIssueId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const park = async (f: Fixture, agentId: string, issueId: string, requestedAt = new Date()) => {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      status: "deferred_issue_execution", requestedAt,
      payload: { issueId, interruptedRunId: randomUUID(), executionWait: { reason: "execution_recovery" } },
    }).returning();
    return row!;
  };

  it("finds the new assignee's wake, not only the finished run's agent's", async () => {
    const f = await seed();
    const wake = await park(f, f.ownerId, f.issueId);
    expect((await findDeferredIssueWake(db, f.companyId, f.issueId))?.id).toBe(wake.id);
  });

  it("ignores wakes of other issues and other statuses", async () => {
    const f = await seed();
    await park(f, f.ownerId, f.otherIssueId);
    const settled = await park(f, f.ownerId, f.issueId);
    await db.update(agentWakeupRequests).set({ status: "queued" }).where(
      (await import("drizzle-orm")).eq(agentWakeupRequests.id, settled.id));
    expect(await findDeferredIssueWake(db, f.companyId, f.issueId)).toBeNull();
  });

  it("returns the oldest wake first", async () => {
    const f = await seed();
    const older = await park(f, f.ownerId, f.issueId, new Date(Date.now() - 5000));
    await park(f, f.outgoingId, f.issueId);
    expect((await findDeferredIssueWake(db, f.companyId, f.issueId))?.id).toBe(older.id);
  });
});
