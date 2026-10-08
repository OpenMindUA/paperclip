import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export interface IdleSleepDrainStatus {
  draining: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  activeRuns: number;
  pendingWakes: number;
}

export interface IdleSleepSafety {
  version: 1;
  backgroundWork: "none" | "present" | "unknown";
}

// These are deliberately conservative. Completed agent runs and workspace
// operations are history, not reasons to keep an otherwise idle instance up.
// Other background features remain awake until their work and inbound events
// have a durable wake path. In particular, an empty in-memory run set is not
// evidence that a restarted process has no persisted work to recover.
const WORK_CHECKS = [
  `SELECT 1 FROM agents WHERE status = 'running' OR
    (status NOT IN ('terminated', 'paused', 'pending_approval') AND
     runtime_config->'heartbeat'->>'enabled' = 'true' AND
     COALESCE((runtime_config->'heartbeat'->>'intervalSec')::numeric, 0) > 0)`,
  `SELECT 1 FROM heartbeat_runs WHERE
    status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    OR scheduled_retry_at IS NOT NULL OR cost_accounting_pending`,
  `SELECT 1 FROM budget_reservations WHERE state NOT IN ('settled', 'released')`,
  // Persistent machine credentials can receive work without a human opening
  // the instance. They need an ingress wake contract before we can sleep.
  `SELECT 1 FROM agent_api_keys WHERE revoked_at IS NULL`,
  `SELECT 1 FROM board_api_keys WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())`,
  `SELECT 1 FROM agent_wakeup_requests WHERE
    status NOT IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out')`,
  `SELECT 1 FROM issues WHERE status NOT IN ('done', 'cancelled')`,
  `SELECT 1 FROM workspace_operations WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`,
  `SELECT 1 FROM environment_leases WHERE status NOT IN ('released', 'expired')`,
  `SELECT 1 FROM routines WHERE status NOT IN ('paused', 'archived')`,
  `SELECT 1 FROM routine_runs WHERE status NOT IN ('completed', 'failed', 'skipped', 'cancelled')`,
  `SELECT 1 FROM plugin_jobs WHERE status <> 'paused'`,
  `SELECT 1 FROM plugin_job_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`,
  `SELECT 1 FROM plugin_webhook_deliveries WHERE status NOT IN ('succeeded', 'failed')`,
  `SELECT 1 FROM tool_connections WHERE status <> 'archived'`,
  `SELECT 1 FROM issue_recovery_actions WHERE status NOT IN ('resolved', 'cancelled')`,
  `SELECT 1 FROM status_cards WHERE archived_at IS NULL`,
  `SELECT 1 FROM external_objects WHERE NOT is_terminal OR next_refresh_at IS NOT NULL`,
  // These less common work sources fail closed on any retained state. Their
  // terminal-state exceptions can be added with tests for the owning service.
  ...[
    "chat_endpoints", "chat_deliveries", "chat_publications", "chat_actions",
    "chat_completion_deliveries", "connection_event_deliveries",
    "connection_intent_deliveries", "tool_action_requests", "tool_action_deliveries",
    "issue_question_response_deliveries", "workspace_runtime_services",
    "execution_workspace_runtime_leases", "pipeline_automation_executions",
    "native_run_finalizations", "company_transfer_runs", "decisions", "decision_effect_executions",
    "decision_archive_notification_outbox", "browser_use_sessions", "browser_use_runs",
    "browser_use_browsers", "environment_custom_image_setup_sessions", "feedback_exports",
    "adapter_auth_sessions", "company_secret_proposals", "execution_workspaces",
  ].map((table) => `SELECT 1 FROM ${table}`),
] as const;

function sameQuietHold(before: IdleSleepDrainStatus, after: IdleSleepDrainStatus, now: number): boolean {
  return before.draining && after.draining && before.activeRuns === 0 && before.pendingWakes === 0
    && after.activeRuns === 0 && after.pendingWakes === 0
    && before.startedAt !== null && after.startedAt?.getTime() === before.startedAt.getTime()
    && (after.expiresAt === null || after.expiresAt.getTime() > now);
}

/** Inventory persisted work after the task-drain admission hold lands.
 * Empty scans remain unknown until ingress and process-local work are fenced.
 */
export async function readIdleSleepSafety(
  db: Db,
  getDrainStatus: () => IdleSleepDrainStatus,
  now: () => number = Date.now,
): Promise<IdleSleepSafety> {
  const unknown: IdleSleepSafety = { version: 1, backgroundWork: "unknown" };
  const before = getDrainStatus();
  if (!sameQuietHold(before, before, now())) return unknown;
  try {
    const blocked = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const checks = WORK_CHECKS.map((query) => sql`EXISTS (${sql.raw(query)})`);
      // Version labels and manifest declarations do not prove arbitrary worker
      // code has no background activity. No plugin approvals are supported.
      checks.push(sql`EXISTS (SELECT 1 FROM plugins WHERE status <> 'disabled')`);
      const rows = await tx.execute<{ blocked: boolean }>(sql`SELECT ${sql.join(checks, sql` OR `)} AS blocked`);
      return rows.length === 1 && typeof rows[0]?.blocked === "boolean" ? rows[0].blocked : undefined;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (blocked === undefined || !sameQuietHold(before, getDrainStatus(), now())) return unknown;
    // A task-drain hold only fences agent starts. It does not fence already
    // admitted HTTP mutations or certify process-local cleanup/accounting debt.
    // Keep an empty database scan non-authorizing until those owners provide
    // a stable admission snapshot. Do not add an environment bypass here.
    return { version: 1, backgroundWork: blocked ? "present" : "unknown" };
  } catch {
    // Missing migrations, unknown state, malformed configuration, timeouts and
    // database failures never authorize stopping the application. Do not leak
    // SQL, configuration or tenant data through this control response.
    return unknown;
  }
}
