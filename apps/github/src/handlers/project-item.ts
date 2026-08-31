import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { EchoCache } from "@foreman/github-client";
import type { FieldMap } from "../sync/field-map.js";
import type { SyncJob } from "../jobs.js";

const itemPayload = z.object({
  action: z.string(),
  projects_v2_item: z.object({
    node_id: z.string(),
    project_node_id: z.string(),
    content_node_id: z.string().nullish(),
  }).passthrough(),
  changes: z.object({
    field_value: z.object({
      field_node_id: z.string(),
      field_type: z.string().nullish(),
      from: z.unknown().nullish(),
      to: z.unknown().nullish(),
    }).passthrough(),
  }).passthrough().nullish(),
}).passthrough();

// §5.3: the webhook's changes.field_value carries enough to mutate without re-querying.
// Values arrive either bare (option ids) or wrapped ({date}, {id, startDate} for iterations).
function normalize(v: unknown): unknown {
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.date === "string") return o.date;
    if (typeof o.iterationId === "string") return o.iterationId;
    if (typeof o.id === "string") return o.id;
  }
  return v;
}

const QUEUE_OWNED = new Set(["claimed", "in_progress", "in_review"]);

export async function handleProjectItemEvent(tx: Queryable, echo: EchoCache, job: SyncJob): Promise<void> {
  const p = itemPayload.safeParse(job.payload);
  if (!p.success) { console.warn(`projects_v2_item payload rejected: ${p.error.message}`); return; }
  const { action, projects_v2_item: item, changes } = p.data;

  const projRow = await tx.query(
    "select id, field_map from projects where organisation_id = $1 and gh_project_node_id = $2",
    [job.organisation_id, item.project_node_id]);
  if (projRow.rowCount === 0) return; // untracked project: noise
  const projectId: string = projRow.rows[0].id;
  const fm: FieldMap = projRow.rows[0].field_map ?? {};

  const fv = changes?.field_value;
  const emit = (workItemId?: string | null) => appendEvent(tx, {
    organisation_id: job.organisation_id, project_id: projectId,
    work_item_id: workItemId ?? undefined,
    type: "github.project_item_changed",
    payload: {
      gh_item_node_id: item.node_id,
      ...(fv ? { field_node_id: fv.field_node_id, from: fv.from ?? null, to: fv.to ?? null } : {}),
    },
    idempotency_key: `ghd:${job.delivery_id}`,
  });

  if (action === "created") {
    if (item.content_node_id) {
      await tx.query(
        "update work_items set gh_item_node_id = $3, updated_at=now() where organisation_id = $1 and gh_issue_node_id = $2",
        [job.organisation_id, item.content_node_id, item.node_id]);
    }
    await emit();
    return;
  }

  if (action === "deleted") {
    await tx.query(
      `update work_items set gh_item_node_id = null, iteration_id = null, start_at = null, target_at = null,
         updated_at=now() where organisation_id = $1 and gh_item_node_id = $2`,
      [job.organisation_id, item.node_id]);
    await emit();
    return;
  }

  if (action !== "edited" || !fv) { await emit(); return; }

  const row = await tx.query(
    "select id, status from work_items where organisation_id = $1 and gh_item_node_id = $2",
    [job.organisation_id, item.node_id]);
  if (row.rowCount === 0) { await emit(); return; }
  const workItemId: string = row.rows[0].id;
  const to = normalize(fv.to);

  // GNT-8: our own reflected write — record the fact, never touch the row again.
  if (await echo.wasOwnWrite(item.node_id, fv.field_node_id, to)) {
    await emit(workItemId);
    return;
  }

  const dateStr = typeof to === "string" ? to : null;
  if (fv.field_node_id === fm.start_field?.node_id) {
    if (fm.start_field.type === "DATE") {
      await tx.query("update work_items set start_at = $2, updated_at=now() where id = $1", [workItemId, dateStr]);
    } else {
      const startDate = (fv.to as Record<string, unknown> | null)?.startDate;
      await tx.query("update work_items set iteration_id = $2, start_at = coalesce($3::date, start_at), updated_at=now() where id = $1",
        [workItemId, to, typeof startDate === "string" ? startDate : null]);
    }
  } else if (fv.field_node_id === fm.target_field?.node_id) {
    await tx.query("update work_items set target_at = $2, updated_at=now() where id = $1", [workItemId, dateStr]);
  } else if (fv.field_node_id === fm.iteration_field?.node_id) {
    await tx.query("update work_items set iteration_id = $2, updated_at=now() where id = $1", [workItemId, to]);
  } else if (fv.field_node_id === fm.status_field?.node_id) {
    let status: string | null = null;
    for (const [name, optId] of Object.entries(fm.status_field.options)) {
      if (optId === to) status = name;
    }
    if (status !== null && !QUEUE_OWNED.has(row.rows[0].status)) {
      await tx.query("update work_items set status = $2, updated_at=now() where id = $1", [workItemId, status]);
    }
  }
  // unmapped field ids fall through: event only

  await emit(workItemId);
}
