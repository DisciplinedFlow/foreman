import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { InMemoryKv, EchoCache } from "@foreman/github-client";
import { handleProjectItemEvent } from "./project-item.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let echo: EchoCache;

const FIELD_MAP = {
  start_field: { node_id: "F_start", type: "DATE" },
  target_field: { node_id: "F_target", type: "DATE" },
  status_field: { node_id: "F_status", type: "SINGLE_SELECT",
    options: { queued: "opt_todo", in_progress: "opt_prog", done: "opt_done" } },
};

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "proj-item"));
  await db.servicePool.query(
    "update projects set gh_project_node_id='PVT_x', field_map=$2 where id=$1",
    [projectId, JSON.stringify(FIELD_MAP)]);
  echo = new EchoCache(new InMemoryKv());
});
afterAll(async () => { await db.teardown(); });

let seq = 0;
async function seedItem(itemNodeId: string, status = "queued"): Promise<string> {
  const r = await db.servicePool.query(
    `insert into work_items (organisation_id, project_id, title, status, gh_item_node_id)
     values ($1,$2,'item',$3,$4) returning id`, [orgId, projectId, status, itemNodeId]);
  return r.rows[0].id;
}

function job(action: string, itemNodeId: string, fieldValue?: object): SyncJob {
  seq += 1;
  return {
    id: String(seq), organisation_id: orgId, installation_id: 777, delivery_id: `pi-${seq}`,
    event_name: "projects_v2_item", action, status: "running", attempts: 1,
    payload: {
      action,
      projects_v2_item: { node_id: itemNodeId, project_node_id: "PVT_x", content_node_id: `C_${itemNodeId}` },
      ...(fieldValue ? { changes: { field_value: fieldValue } } : {}),
    },
  };
}

describe("projects_v2_item handler", () => {
  it("date edit updates start_at and appends github.project_item_changed", async () => {
    await seedItem("ITEM_date");
    await handleProjectItemEvent(db.servicePool, echo,
      job("edited", "ITEM_date", { field_node_id: "F_start", field_type: "date", from: null, to: { date: "2026-09-03" } }));
    const w = await db.servicePool.query("select start_at::text from work_items where gh_item_node_id='ITEM_date'");
    expect(w.rows[0].start_at).toBe("2026-09-03");
    const e = await db.servicePool.query(
      "select 1 from events where type='github.project_item_changed' and payload->>'gh_item_node_id'='ITEM_date'");
    expect(e.rowCount).toBe(1);
  });

  it("status edit flips queued→done but never an in_progress item", async () => {
    await seedItem("ITEM_q", "queued");
    await seedItem("ITEM_ip", "in_progress");
    const fv = { field_node_id: "F_status", field_type: "single_select", from: "opt_todo", to: "opt_done" };
    await handleProjectItemEvent(db.servicePool, echo, job("edited", "ITEM_q", fv));
    await handleProjectItemEvent(db.servicePool, echo, job("edited", "ITEM_ip", fv));
    const q = await db.servicePool.query("select status from work_items where gh_item_node_id='ITEM_q'");
    const ip = await db.servicePool.query("select status from work_items where gh_item_node_id='ITEM_ip'");
    expect(q.rows[0].status).toBe("done");
    expect(ip.rows[0].status).toBe("in_progress");
  });

  it("echo-recorded value: event appended, row untouched (GNT-8)", async () => {
    await seedItem("ITEM_echo");
    await echo.record("ITEM_echo", "F_target", "2026-09-20");
    await handleProjectItemEvent(db.servicePool, echo,
      job("edited", "ITEM_echo", { field_node_id: "F_target", field_type: "date", from: null, to: { date: "2026-09-20" } }));
    const w = await db.servicePool.query("select target_at from work_items where gh_item_node_id='ITEM_echo'");
    expect(w.rows[0].target_at).toBeNull();
    const e = await db.servicePool.query(
      "select 1 from events where type='github.project_item_changed' and payload->>'gh_item_node_id'='ITEM_echo'");
    expect(e.rowCount).toBe(1);
  });

  it("unknown field_node_id → event only", async () => {
    await seedItem("ITEM_unknown");
    await handleProjectItemEvent(db.servicePool, echo,
      job("edited", "ITEM_unknown", { field_node_id: "F_mystery", field_type: "text", from: "a", to: "b" }));
    const w = await db.servicePool.query(
      "select start_at, target_at, status from work_items where gh_item_node_id='ITEM_unknown'");
    expect(w.rows[0]).toMatchObject({ start_at: null, target_at: null, status: "queued" });
    const e = await db.servicePool.query(
      "select 1 from events where type='github.project_item_changed' and payload->>'gh_item_node_id'='ITEM_unknown'");
    expect(e.rowCount).toBe(1);
  });

  it("deleted clears linkage + schedule columns", async () => {
    const id = await seedItem("ITEM_del");
    await db.servicePool.query(
      "update work_items set start_at='2026-09-01', target_at='2026-09-05', iteration_id='it_1' where id=$1", [id]);
    await handleProjectItemEvent(db.servicePool, echo, job("deleted", "ITEM_del"));
    const w = await db.servicePool.query(
      "select gh_item_node_id, iteration_id, start_at, target_at from work_items where id=$1", [id]);
    expect(w.rows[0]).toEqual({ gh_item_node_id: null, iteration_id: null, start_at: null, target_at: null });
  });
});
