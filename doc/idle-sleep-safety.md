# Automatic idle sleep work inventory

This report is a conservative inventory, not a complete sleep authorization.
The current implementation returns `present` or `unknown`. It never returns
`none`, including for an empty instance, so deploying it cannot enable automatic
sleep or stop existing background work.

`GET /api/instance/task-drain?idleSleepSafety=1` adds an instance-wide
`idleSleepSafety` report for instance administrators and authenticated Cloud
control callers. Ordinary task-drain status and deploy/restart drains keep their
existing behavior. Company members and agents cannot read this report.

The hosting controller must acquire the task-drain hold and wait for zero active
runs and pending wakes before requesting the report.
Only `{ "version": 1, "backgroundWork": "none" }` permits automatic sleep.
`present`, `unknown`, errors, and missing reports must keep the instance awake.
This endpoint does not stop processes or schedule a future wake.

The report checks persisted work in a bounded read-only transaction. It checks
the same live admission hold before and after the scan. Queued and orphaned
runs, future timers and retries, accounting debt, unfinished issues and cleanup,
active routines, integrations, external API credentials, and plugin work report
`present`. An idle agent and completed ordinary run history alone do not prove
the absence of all work and still return `unknown`.
Less common work sources conservatively block sleep on retained records, even
when those records might be terminal. Database errors and missing migrations
produce `unknown`; the response contains no tenant details or database errors.

Plugins can execute arbitrary background code. Every enabled plugin blocks
sleep, including plugins with no declared jobs or webhooks. Version labels
alone do not bind approval to reviewed worker contents. This report supports
no plugin approval policy.

Scheduled and externally triggered work needs a durable hosting wake mechanism
before it can be admitted to automatic sleep. A future timestamp alone is not
such a mechanism. Add new background work sources to the safety report when
introducing them. Missing support must fail closed.

Before allowing `none`, complete and test these guarantees:

- Fence new ingress and wait for already-admitted mutations to finish. A quiet
  agent drain is insufficient. Related work is tracked in public PR #13413;
  runtime-service admission alone does not cover every HTTP mutation.
- Read accounting and sandbox cleanup spools without interpreting read failures
  or malformed entries as empty. Include buffered and in-flight cleanup after
  failed database or spool writes.
- Keep the same owned admission hold through the final report and provider stop.
  A restart, expired hold or operator replacement invalidates the report.

This PR does not add a configuration switch that bypasses these guarantees.
