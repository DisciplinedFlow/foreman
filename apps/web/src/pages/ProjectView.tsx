import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, patchSchedule, useProjectStream } from "../api.js";
import { AgentTable, type AgentRow } from "../agents/AgentTable.js";
import { DecisionCards, type CheckpointRow } from "../checkpoints/DecisionCards.js";
import { CommGraph, type CommNode, type CommEdge } from "../graph/CommGraph.js";
import { OverviewTab, type OverviewSection, type OverviewRevision } from "../overview/OverviewTab.js";
import { LifecycleTab, type EndpointRow, type LifecycleGaps } from "../lifecycle/LifecycleTab.js";
import { SettingsTab, type ProjectSettings, type InstallationRow, type TokenRow } from "../settings/SettingsTab.js";
import { MetricsTab, type Metrics } from "../metrics/MetricsTab.js";
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
  const [tab, setTab] = useState<"gantt" | "agents" | "graph" | "overview" | "lifecycle" | "settings" | "metrics">("gantt");
  const [settings, setSettings] = useState<{ project: ProjectSettings; installations: InstallationRow[]; tokens: TokenRow[] } | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItem, setNewItem] = useState({ title: "", intent: "", kind: "task", priority: "100" });
  const [lifecycle, setLifecycle] = useState<{ endpoints: EndpointRow[]; gaps: LifecycleGaps } | null>(null);
  const [scanQueued, setScanQueued] = useState(false);
  const [overview, setOverview] = useState<OverviewSection[]>([]);
  const [revisions, setRevisions] = useState<Record<string, OverviewRevision[]>>({});
  const [regenBusy, setRegenBusy] = useState(false);
  const [name, setName] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [deps, setDeps] = useState<Dep[]>([]);
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [graph, setGraph] = useState<{ nodes: CommNode[]; edges: CommEdge[] } | null>(null);

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
        const g = await api<{ nodes: CommNode[]; edges: CommEdge[] }>(`/api/projects/${projectId}/comm-graph`);
        setGraph(g);
      }
      if (scopes.includes("checkpoints")) {
        const body = await api<{ checkpoints: CheckpointRow[] }>(`/api/projects/${projectId}/checkpoints`);
        setCheckpoints(body.checkpoints);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
    }
  }, [projectId, navigate]);

  useEffect(() => {
    void load(["items", "schedule", "agents", "checkpoints"]);
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

  const loadOverview = useCallback(() => {
    api<{ sections: OverviewSection[] }>(`/api/projects/${projectId}/overview`)
      .then((b) => setOverview(b.sections))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => { if (tab === "overview") loadOverview(); }, [tab, loadOverview]);

  const loadSettings = useCallback(async () => {
    try {
      const p = await api<{ project: ProjectSettings }>(`/api/projects/${projectId}`);
      const orgId = (p.project as unknown as { organisation_id: string }).organisation_id;
      const inst = await api<{ installations: InstallationRow[] }>(`/api/orgs/${orgId}/installations`);
      const tok = await api<{ tokens: TokenRow[] }>(`/api/projects/${projectId}/tokens`);
      setSettings({ project: p.project, installations: inst.installations, tokens: tok.tokens });
    } catch { /* 401 handled by other loaders */ }
  }, [projectId]);

  useEffect(() => { if (tab === "settings") void loadSettings(); }, [tab, loadSettings]);

  useEffect(() => {
    if (tab !== "metrics") return;
    api<Metrics>(`/api/projects/${projectId}/metrics`).then(setMetrics).catch(() => {});
  }, [tab, projectId]);

  useEffect(() => {
    if (tab !== "lifecycle") return;
    api<{ endpoints: EndpointRow[]; gaps: LifecycleGaps }>(`/api/projects/${projectId}/lifecycle`)
      .then(setLifecycle)
      .catch(() => {});
  }, [tab, projectId]);

  const onOverviewOverride = (sectionId: string, body: { content?: string; pinned?: boolean }) => {
    api(`/api/projects/${projectId}/overview/${sectionId}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).finally(loadOverview);
  };

  const onOverviewRegenerate = () => {
    setRegenBusy(true);
    api(`/api/projects/${projectId}/overview/regenerate`, { method: "POST" })
      .finally(() => { setRegenBusy(false); loadOverview(); });
  };

  const onCheckpointAnswer = (id: string, answer: string) => {
    api(`/api/checkpoints/${id}/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    }).finally(() => { void load(["checkpoints", "agents"]); });
  };

  return (
    <main style={{ padding: 16 }}>
      <h1>{name || "Project"}</h1>
      <DecisionCards checkpoints={checkpoints} onAnswer={onCheckpointAnswer} />
      <nav style={{ marginBottom: 12 }}>
        <button onClick={() => setTab("gantt")} disabled={tab === "gantt"}>Gantt</button>{" "}
        <button onClick={() => setTab("agents")} disabled={tab === "agents"}>Agents</button>{" "}
        <button onClick={() => setTab("graph")} disabled={tab === "graph"}>Graph</button>{" "}
        <button onClick={() => setTab("overview")} disabled={tab === "overview"}>Overview</button>{" "}
        <button onClick={() => setTab("lifecycle")} disabled={tab === "lifecycle"}>Lifecycle</button>{" "}
        <button onClick={() => setTab("metrics")} disabled={tab === "metrics"}>Metrics</button>{" "}
        <button onClick={() => setTab("settings")} disabled={tab === "settings"}>Settings</button>
      </nav>
      {tab === "gantt" && (
        <>
          <p>
            <button onClick={() => setNewItemOpen((o) => !o)}>{newItemOpen ? "✕ Cancel" : "+ New item"}</button>
          </p>
          {newItemOpen && (
            <form style={{ marginBottom: 12 }} onSubmit={(e) => {
              e.preventDefault();
              if (newItem.title.trim() === "") return;
              api(`/api/projects/${projectId}/items`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: newItem.title.trim(),
                  ...(newItem.intent.trim() !== "" ? { intent: newItem.intent.trim() } : {}),
                  kind: newItem.kind, priority: Number(newItem.priority),
                }),
              }).finally(() => {
                setNewItem({ title: "", intent: "", kind: "task", priority: "100" });
                setNewItemOpen(false);
                void load(["items", "schedule"]);
              });
            }}>
              <label>Title <input value={newItem.title} autoFocus
                onChange={(e) => setNewItem((n) => ({ ...n, title: e.target.value }))} /></label>{" "}
              <label>Intent <input value={newItem.intent}
                onChange={(e) => setNewItem((n) => ({ ...n, intent: e.target.value }))} /></label>{" "}
              <label>Kind <select value={newItem.kind}
                onChange={(e) => setNewItem((n) => ({ ...n, kind: e.target.value }))}>
                {["task", "story", "bug", "epic", "chore"].map((k) => <option key={k} value={k}>{k}</option>)}
              </select></label>{" "}
              <label>Priority <input type="number" style={{ width: 70 }} value={newItem.priority}
                onChange={(e) => setNewItem((n) => ({ ...n, priority: e.target.value }))} /></label>{" "}
              <button type="submit">Create</button>
            </form>
          )}
          <Gantt items={ganttItems} deps={deps} onReschedule={onReschedule} />
        </>
      )}
      {tab === "agents" && (
        <AgentTable agents={agents} onAction={(agentId, kind, extra) => {
          api(`/api/agents/${agentId}/directives`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind, ...extra }),
          }).finally(() => { void load(["agents"]); });
        }} />
      )}
      {tab === "graph" && (graph !== null
        ? <CommGraph nodes={graph.nodes} edges={graph.edges} />
        : <p>No communication data yet.</p>)}
      {tab === "lifecycle" && (
        <LifecycleTab
          endpoints={lifecycle?.endpoints ?? []}
          gaps={lifecycle?.gaps ?? { untested: 0, unimplemented: 0, unspecced: 0 }}
          scanning={scanQueued}
          onScan={() => {
            setScanQueued(true);
            api(`/api/projects/${projectId}/lifecycle/scan`, { method: "POST" })
              .finally(() => setTimeout(() => setScanQueued(false), 3000));
          }} />
      )}
      {tab === "metrics" && (metrics !== null ? <MetricsTab metrics={metrics} /> : <p>Loading metrics…</p>)}
      {tab === "settings" && (settings !== null ? (
        <SettingsTab project={settings.project} installations={settings.installations} tokens={settings.tokens}
          exportUrl={`/api/projects/${projectId}/export`}
          onSave={(body) => {
            api(`/api/projects/${projectId}/settings`, {
              method: "PATCH", headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }).finally(() => { void loadSettings(); });
          }}
          onMintToken={() => api<{ token_id: string; token: string }>(`/api/projects/${projectId}/tokens`, { method: "POST" })
            .then((t) => { void loadSettings(); return t; })}
          onRevokeToken={(id) => {
            api(`/api/tokens/${id}`, { method: "DELETE" }).finally(() => { void loadSettings(); });
          }} />
      ) : <p>Loading settings…</p>)}
      {tab === "overview" && (
        <OverviewTab sections={overview} onOverride={onOverviewOverride}
          onRegenerate={onOverviewRegenerate} busy={regenBusy}
          revisions={revisions}
          onLoadHistory={(sectionId) => {
            api<{ revisions: OverviewRevision[] }>(`/api/projects/${projectId}/overview/${sectionId}/revisions`)
              .then((b) => setRevisions((r) => ({ ...r, [sectionId]: b.revisions })))
              .catch(() => {});
          }} />
      )}
    </main>
  );
}
