Minimal Change and Maintainability Rules

When modifying this codebase:

1. Prefer the smallest safe change that satisfies the requirement.
2. Do not refactor unrelated code unless explicitly requested.
3. Preserve existing architecture, naming conventions, and public interfaces.
4. Before making a change, identify the source of truth and the smallest set of affected files.
5. Update only tests affected by the change, while maintaining appropriate regression coverage.
6. Avoid unnecessary abstractions, wrappers, utilities, or additional layers.
7. After implementation, summarize:
    * What changed
    * Why it changed
    * Which files contain the main business logic
    * Which tests were added or updated
    * Any remaining risks
8. Keep the code understandable and maintainable by a senior developer without AI assistance.

Important: Optimize for long-term maintainability, not maximum code generation.

## Shared CarbonLite Pilot Tracker

The authoritative pilot task tracker lives at:

`../carbonlite-web/docs/pilot/CARBONLITE_MASTER_TODO.md`

At the start of pilot, security, recovery, release, infrastructure, or customer-onboarding work, read this tracker when it is available. Use its task IDs, priorities, dependencies, planned dates, and acceptance criteria.

After completing work, update the authoritative tracker when the sibling repository is available and tracker edits are in scope. Follow `../carbonlite-web/docs/pilot/carbonlite-task-tracker-maintenance.md` and synchronize `../carbonlite-web/docs/pilot/CarbonLite_Pilot_Task_Tracker.xlsx` where practical.

Do not create a second independent Master TODO inside `carbonlite-api`. If the sibling repository is unavailable, or tracker editing is out of scope, report the exact proposed task-ID-specific updates in the final response. Do not assume access to the sibling repository in every Codex session.

Never treat local code or test success as provider verification, production deployment, operational approval, or permission to accept real customer data. Never silently close a P0 blocker or record a legal, privacy, or owner approval without explicit authorization and dated evidence.

## Session Handoff and Master TODO Update

For work covered by the shared tracker, include a short `Master TODO Update` section in the execution summary with:

- Current phase, task ID, and scope.
- Completed work and exact evidence.
- Open P0 blockers, including any newly discovered blocker.
- Next recommended tasks and dependencies.
- Files changed.
- Test commands and results, distinguishing tests run from tests merely recommended.
- Deployment status, including whether production deployment was not attempted or not authorized.
- Explicit STOP conditions and the authority needed to proceed.

If the tracker was updated, state which task IDs and fields changed and whether the Excel tracker was synchronized. Otherwise, report the proposed updates without modifying unrelated files.

## CarbonLite Founder Operating Workflow

At the start and end of any CarbonLite task, apply this workflow within the user's explicit scope and use the shared frontend-repository operating files when the sibling repository is available:

- Master TODO: `../carbonlite-web/docs/pilot/CARBONLITE_MASTER_TODO.md`
- Founder Dashboard: `../carbonlite-web/docs/pilot/CARBONLITE_FOUNDER_DASHBOARD.md`
- Decision Log: `../carbonlite-web/docs/pilot/CARBONLITE_DECISION_LOG.md`
- Excel tracker: `../carbonlite-web/docs/pilot/CarbonLite_Pilot_Task_Tracker.xlsx`

### At the start of the task

1. Read the Master TODO and Founder Dashboard; read the Decision Log when the work depends on or records a founder, legal, privacy, commercial, infrastructure, or go/no-go decision.
2. Find the matching existing task ID and check its priority, dependencies, blockers, acceptance criteria, evidence level, scope, and STOP conditions.
3. Do not create duplicate CarbonLite trackers or task IDs in `carbonlite-api`, and do not proceed through a blocked P0 gate without the required explicit approval.

### At the end of the task

1. When shared-tracker editing is in scope, update the existing Master TODO task with exact files changed, test results, newly discovered P0/P1 blockers, dependencies, evidence references, suggested dates, and the demonstrated evidence level. Do not move a planned date without recording the rationale.
2. Update the Founder Dashboard only with concise, cited summaries; it is not a second task tracker.
3. Change the Decision Log only for explicit, dated authorization. Otherwise leave the decision `PENDING` and report the proposed update.
4. Synchronize the Excel tracker only when authoritative task fields changed and workbook editing is safe and in scope.
5. Refresh the dashboard timestamp only when its content changes.
6. Include a short `Founder Dashboard Update` section in the execution summary stating dashboard changes, decision-log changes, current Top 5 priorities, and unapplied proposals.

### Daily and weekly operating rhythm

- Daily: review the dashboard Top 3; include a customer/sales action when appropriate; identify one engineering outcome and one founder decision when needed. A scheduled action is not a completed action.
- Weekly: review P0 closure, the prospect/contact/demo/pilot funnel, customer feedback, and next-week priorities; record only approved decisions; change planned dates only with a documented rationale.

Never fabricate sales activity, customer feedback, provider verification, deployment, approval, or operational readiness. Never mark `DONE` without acceptance evidence, turn a local GO into a production GO, or convert local evidence into `PROVIDER_VERIFIED`, `PRODUCTION_DEPLOYED`, or `OPERATIONALLY_APPROVED`. Do not update unrelated files for a read-only request. If the sibling repository is unavailable, do not create local substitutes; complete only the in-repository work and report exact proposed changes to the shared files.
