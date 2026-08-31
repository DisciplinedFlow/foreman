import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, patchSchedule, useProjectStream } from "../api.js";
import { AgentTable, type AgentRow } from "../agents/AgentTable.js";
import { Gantt } from "../gantt/Gantt.js";
import { mergeSchedule, type GanttItem } from "../gantt/layout.js";

interface ItemRow {
  id: string; title: string; status: string; kind: string; parent_id: string | null;
  start_at: string | null; target_at: string | null;
}
interface Dep { blocked_id: string; blocker_id: string }
interface ScheduleRow { work_item_id: string; critical: boolean; slack: number }

const toDate = (v: string | null) => (v === null ? null : v.slice(0, 10));

export function ProjectView() {
  const { id } = useParams();
  const projectId = id!;
  const navigate = useNavigate();
  const [tab, setTab] = useState<"gantt" | "agents">("gantt");
  const [name, setName] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [deps, setDeps] = useState<Dep[]>([]);
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);

  const load = useCallback(async (scopes: string[]) => {
    try {
      if (scopes.includes("items")) {
        const body = await api<{ items: ItemRow[]; deps: Dep[] }>(`/api/projects/${projectId}/items`);
        setItems(body.items);
        setDeps(body.deps);
      }
      if (scopes.includes("schedule")) {
        const body = await api<{ schedule: ScheduleRow[] }>(`/api/projects/${projectId}/schedule`);
        setSchedule(body.schedule);
      }
      if (scopes.includes("agents")) {
        const body = await api<{ agents: AgentRow[] }>(`/api/projects/${projectId}/agents`);
        setAgents(body.agents);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
    }
  }, [projectId, navigate]);

  useEffect(() => {
    void load(["items", "schedule", "agents"]);
    api<{ project: { name: string } }>(`/api/projects/${projectId}`)
      .then((b) => setName(b.project.name))
      .catch(() => {});
  }, [projectId, load]);

  useProjectStream(projectId, (scopes) => { void load(scopes); });

  const ganttItems: GanttItem[] = mergeSchedule(
    items.map((i) => ({
      id: i.id, title: i.title, status: i.status, kind: i.kind, parentId: i.parent_id,
      startAt: toDate(i.start_at), targetAt: toDate(i.target_at), critical: false, slack: null,
    })),
    schedule,
  );

  const onReschedule = (itemId: string, change: { start_at?: string; target_at?: string }) => {
    // Deviation 4: optimistic local move; the SSE schedule invalidate confirms.
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, ...change } : i)));
    patchSchedule(itemId, change).catch(() => { void load(["items", "schedule"]); });
  };

  return (
    <main style={{ padding: 16 }}>
      <h1>{name || "Project"}</h1>
      <nav style={{ marginBottom: 12 }}>
        <button onClick={() => setTab("gantt")} disabled={tab === "gantt"}>Gantt</button>{" "}
        <button onClick={() => setTab("agents")} disabled={tab === "agents"}>Agents</button>
      </nav>
      {tab === "gantt"
        ? <Gantt items={ganttItems} deps={deps} onReschedule={onReschedule} />
        : <AgentTable agents={agents} />}
    </main>
  );
}
