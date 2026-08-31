import { appendEvent, type Queryable } from "@foreman/db";
import type { GithubClientLike } from "../sync/field-map.js";
import {
  extractOpenApi, extractExpress, extractFastApi, extractNextRoutes, detectTests,
  extractDjango, extractRails, extractSpring, type Found,
} from "./extract.js";

export interface ScanProject {
  id: string;
  organisation_id: string;
  gh_repos: string[];
  gh_installation_id: string | number | null;
}

const SPEC_FILE = /(^|\/)(openapi|swagger|asyncapi)\.(json|ya?ml)$/i;
const TEST_FILE = /(\.test\.|_test\.py$|(^|\/)tests?\/)/;
const CODE_FILE = /(\.(ts|js|py|java)|(^|\/)routes\.rb)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.git)\//;
const MAX_CODE_FILES = 50;
const MAX_TEST_FILES = 20;

interface Merged {
  in_spec: boolean; has_impl: boolean; trivial: boolean; has_test: boolean;
  evidence: Array<{ kind: string; ref: string }>;
}

function computeState(m: Merged, previous: string | null): string {
  if (previous === "deployed") return "deployed"; // sticky while the endpoint still exists
  if (m.has_impl) {
    if (m.has_test) return "tested";
    return m.trivial ? "stubbed" : "implemented";
  }
  return "planned";
}

// LFC-1/2: walk the repo tree over the API, extract endpoints, upsert with
// evidence. Absent-but-known endpoints become deprecated.
export async function scanLifecycle(
  tx: Queryable, gh: GithubClientLike, project: ScanProject,
): Promise<{ found: number; changed: number }> {
  const installationId = Number(project.gh_installation_id ?? 0);
  const appRow = await tx.query(
    "select app_id from github_installations where installation_id = $1", [installationId]);
  if (appRow.rowCount === 0) throw new Error(`no installation ${installationId}`);
  const appId = Number(appRow.rows[0].app_id);

  let totalFound = 0;
  let totalChanged = 0;

  for (const repo of project.gh_repos) {
    const tree = await gh.rest(appId, installationId, "GET", `/repos/${repo}/git/trees/HEAD?recursive=1`);
    if (tree.status !== 200 || !Array.isArray(tree.json?.tree)) continue;
    const paths: string[] = tree.json.tree
      .filter((n: { path?: string; type?: string }) => n.type === "blob" && typeof n.path === "string")
      .map((n: { path: string }) => n.path)
      .filter((p: string) => !SKIP.test(p));

    const specFiles = paths.filter((p) => SPEC_FILE.test(p));
    const testFiles = paths.filter((p) => TEST_FILE.test(p) && CODE_FILE.test(p)).slice(0, MAX_TEST_FILES);
    const codeFiles = paths.filter((p) => CODE_FILE.test(p) && !TEST_FILE.test(p) && !SPEC_FILE.test(p))
      .slice(0, MAX_CODE_FILES);

    const fetchContent = async (p: string): Promise<string | null> => {
      const res = await gh.rest(appId, installationId, "GET", `/repos/${repo}/contents/${encodeURIComponent(p)}`);
      if (res.status !== 200 || typeof res.json?.content !== "string") return null;
      return Buffer.from(res.json.content, "base64").toString("utf8");
    };

    // Extraction
    const merged = new Map<string, Merged>();
    const add = (f: Found, ref: string) => {
      const key = `${f.method} ${f.path}`;
      const m = merged.get(key) ?? { in_spec: false, has_impl: false, trivial: true, has_test: false, evidence: [] };
      if (f.source === "spec") { m.in_spec = true; m.evidence.push({ kind: "spec", ref }); }
      else {
        m.has_impl = true;
        if (f.trivial !== true) m.trivial = false; // a non-trivial impl wins
        m.evidence.push({ kind: "impl", ref });
      }
      merged.set(key, m);
    };

    for (const p of specFiles) {
      const c = await fetchContent(p);
      if (c !== null) for (const f of extractOpenApi(c)) add(f, p);
    }
    for (const p of codeFiles) {
      const c = await fetchContent(p);
      if (c === null) continue;
      const found = p.endsWith(".py") ? [...extractFastApi(c), ...extractDjango(c)]
        : p.endsWith("routes.rb") ? extractRails(c)
        : p.endsWith(".java") ? extractSpring(c)
        : [...extractNextRoutes(p, c), ...extractExpress(c)];
      for (const f of found) add(f, p);
    }
    const allEndpoints = [...merged.entries()].map(([k]) => {
      const [method, ...rest] = k.split(" ");
      return { method: method!, path: rest.join(" ") };
    });
    for (const p of testFiles) {
      const c = await fetchContent(p);
      if (c === null) continue;
      for (const hitPath of detectTests(c, allEndpoints)) {
        for (const [key, m] of merged) {
          if (key.endsWith(` ${hitPath}`)) { m.has_test = true; m.evidence.push({ kind: "test", ref: p }); }
        }
      }
    }
    totalFound += merged.size;

    // Upsert with the state machine
    const existing = await tx.query(
      "select id, method, path, state from endpoints where project_id = $1 and gh_repo = $2",
      [project.id, repo]);
    const existingBy = new Map(existing.rows.map((r: any) => [`${r.method} ${r.path}`, r]));
    let changed = 0;

    for (const [key, m] of merged) {
      const [method, ...rest] = key.split(" ");
      const path = rest.join(" ");
      const prev = existingBy.get(key);
      const state = computeState(m, prev?.state ?? null);
      // LFC-3 heuristic (deviation 3)
      const linked = path.length >= 4
        ? await tx.query(
            `select id from work_items where project_id = $1 and (title ilike $2 or intent ilike $2) limit 20`,
            [project.id, `%${path}%`])
        : { rows: [] as Array<{ id: string }> };
      const stateChanged = prev === undefined || prev.state !== state;
      await tx.query(
        `insert into endpoints (organisation_id, project_id, gh_repo, method, path, state, evidence,
           work_item_ids, in_spec, has_impl, has_test, state_changed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         on conflict (project_id, method, path) do update set
           state = $6, evidence = $7, work_item_ids = $8, in_spec = $9, has_impl = $10, has_test = $11,
           state_changed_at = case when endpoints.state <> $6 then now() else endpoints.state_changed_at end`,
        [project.organisation_id, project.id, repo, method, path, state, JSON.stringify(m.evidence),
         linked.rows.map((r: { id: string }) => r.id), m.in_spec, m.has_impl, m.has_test]);
      if (stateChanged) changed += 1;
    }

    // Vanished → deprecated
    for (const [key, row] of existingBy) {
      if (merged.has(key) || row.state === "deprecated") continue;
      await tx.query(
        "update endpoints set state='deprecated', state_changed_at=now() where id = $1", [row.id]);
      changed += 1;
    }
    totalChanged += changed;

    await appendEvent(tx, {
      organisation_id: project.organisation_id, project_id: project.id,
      type: "lifecycle.scanned", payload: { gh_repo: repo, found: merged.size, changed },
    });
  }

  return { found: totalFound, changed: totalChanged };
}
