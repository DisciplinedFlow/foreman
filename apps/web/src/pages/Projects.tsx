import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api.js";

interface Org { id: string; slug: string }
interface Project { id: string; name: string; gh_repos: string[] }

export function Projects() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<Record<string, Project[]>>({});
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const { orgs } = await api<{ orgs: Org[] }>("/api/orgs");
        setOrgs(orgs);
        for (const org of orgs) {
          const { projects } = await api<{ projects: Project[] }>(`/api/orgs/${org.id}/projects`);
          setProjects((p) => ({ ...p, [org.id]: projects }));
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      }
    })();
  }, [navigate]);

  return (
    <>
      <header className="topbar">
        <span className="topbar__title">Foreman</span>
      </header>
      <main className="container container--narrow" style={{ paddingBlock: "var(--sp-6)" }}>
        <h1 style={{ marginBottom: "var(--sp-5)" }}>Projects</h1>
        {orgs.length === 0 && (
          <div className="empty">
            <span className="empty__title">No workspaces yet</span>
            <span>Projects you can access will appear here.</span>
          </div>
        )}
        {orgs.map((org) => (
          <section key={org.id} style={{ marginBottom: "var(--sp-6)" }}>
            <h2 style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-3)", marginBottom: "var(--sp-3)" }}>{org.slug}</h2>
            <div className="card stack">
              {(projects[org.id] ?? []).map((p, i) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="row gap-3"
                  style={{ padding: "var(--sp-4)", color: "var(--text)", borderTop: i === 0 ? "none" : "1px solid var(--separator-2)", transition: "background var(--dur) var(--ease)" }}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  {p.gh_repos.length > 0 && <span className="badge">{p.gh_repos.join(", ")}</span>}
                  <span className="topbar__spacer" />
                  <span aria-hidden style={{ color: "var(--text-3)" }}>›</span>
                </Link>
              ))}
              {(projects[org.id] ?? []).length === 0 && (
                <div style={{ padding: "var(--sp-4)", color: "var(--text-3)" }}>No projects.</div>
              )}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
