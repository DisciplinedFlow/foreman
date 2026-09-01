import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  const [settings, setSettings] = useState<{ project: ProjectSettings; installations: InstallationRow[]; tokens: TokenRow[]; orgSlug: string } | null>(null);
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
      const orgs = await api<{ orgs: Array<{ id: string; slug: string }> }>(`/api/orgs`);
      const orgSlug = orgs.orgs.find((o) => o.id === orgId)?.slug ?? "";
      setSettings({ project: p.project, installations: inst.installations, tokens: tok.tokens, orgSlug });
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

  const tabs = [
    ["gantt", "Gantt"], ["agents", "Agents"], ["graph", "Graph"], ["overview", "Overview"],
    ["lifecycle", "Lifecycle"], ["metrics", "Metrics"], ["settings", "Settings"],
  ] as const;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="back-link"><span aria-hidden>‹</span> Projects</Link>
        <span className="topbar__title">{name || "Project"}</span>
      </header>
      <main className="container" style={{ paddingBlock: "var(--sp-5)" }}>
        <DecisionCards checkpoints={checkpoints} onAnswer={onCheckpointAnswer} />
        <nav className="segmented" role="tablist" aria-label="Project sections" style={{ marginBottom: "var(--sp-5)" }}>
          {tabs.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
          ))}
        </nav>
      {tab === "gantt" && (
        <>
          <p>
            <button className={newItemOpen ? "btn-ghost" : "btn-primary"} onClick={() => setNewItemOpen((o) => !o)}>{newItemOpen ? "Cancel" : "+ New item"}</button>
          </p>
          {newItemOpen && (
            <form className="card card--pad row wrap gap-3" style={{ marginBottom: "var(--sp-4)", alignItems: "flex-end" }} onSubmit={(e) => {
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
              <label>Title <input name="title" autoComplete="off" value={newItem.title} autoFocus
                onChange={(e) => setNewItem((n) => ({ ...n, title: e.target.value }))} /></label>{" "}
              <label>Intent <input name="intent" autoComplete="off" value={newItem.intent}
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
        : <div className="empty"><span className="empty__title">No communication yet</span><span>Agent spawns and messages will map here.</span></div>)}
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
      {tab === "metrics" && (metrics !== null ? <MetricsTab metrics={metrics} /> : (
        <div className="stat-grid" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      ))}
      {tab === "settings" && (settings !== null ? (
        <SettingsTab project={settings.project} installations={settings.installations} tokens={settings.tokens}
          orgSlug={settings.orgSlug}
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
      ) : <p className="muted">Loading settings…</p>)}
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
    </>
  );
}
