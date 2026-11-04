import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/**
 * The oldest wake parked in `deferred_issue_execution` for an issue, whoever it
 * is addressed to. A run that hands its issue to another agent releases the
 * issue lock last, so the wake that waits on it belongs to the new assignee,
 * not to the run's own agent. With `preferAgentId`, that agent's wakes come first.
 */
export async function findDeferredIssueWake(db: Db, companyId: string, issueId: string, preferAgentId?: string) {
  const [pending] = await db.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).orderBy(
      ...(preferAgentId ? [desc(sql`${agentWakeupRequests.agentId} = ${preferAgentId}`)] : []),
      asc(agentWakeupRequests.requestedAt),
    ).limit(1);
  return pending ?? null;
}
