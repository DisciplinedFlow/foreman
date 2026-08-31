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
    <main style={{ maxWidth: 720, margin: "4vh auto", padding: 16 }}>
      <h1>Projects</h1>
      {orgs.map((org) => (
        <section key={org.id}>
          <h2>{org.slug}</h2>
          <ul>
            {(projects[org.id] ?? []).map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`}>{p.name}</Link>
                {p.gh_repos.length > 0 && <small> — {p.gh_repos.join(", ")}</small>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
