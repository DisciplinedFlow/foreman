// ProjectV2FieldType values verified by live introspection 31-08-2026 (SPEC §11 item 5).
const KNOWN_DATA_TYPES = new Set([
  "ASSIGNEES", "LINKED_PULL_REQUESTS", "REVIEWERS", "LABELS", "MILESTONE", "REPOSITORY",
  "TITLE", "TEXT", "SINGLE_SELECT", "MULTI_SELECT", "NUMBER", "DATE", "ITERATION",
  "TRACKS", "TRACKED_BY", "ISSUE_TYPE", "PARENT_ISSUE", "SUB_ISSUES_PROGRESS",
  "CREATED", "UPDATED", "CLOSED",
]);

export interface GithubClientLike {
  rest(appId: number, installationId: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  graphql<T = any>(appId: number, installationId: number, query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface FieldMap {
  start_field?: { node_id: string; type: "DATE" | "ITERATION" };
  target_field?: { node_id: string; type: "DATE" | "ITERATION" };
  status_field?: { node_id: string; type: "SINGLE_SELECT"; options: Record<string, string> };
  iteration_field?: { node_id: string };
}

const FIELDS_QUERY = `
query ($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
          ... on ProjectV2IterationField { configuration { duration startDay } }
        }
      }
    }
  }
}`;

const STATUS_OPTION_MAP: Record<string, string> = {
  todo: "queued", queued: "queued", "in progress": "in_progress", done: "done",
};

export async function discoverFieldMap(
  gh: GithubClientLike, appId: number, installationId: number, projectNodeId: string,
): Promise<FieldMap> {
  const data = await gh.graphql<{ node: { fields: { nodes: Array<{ id: string; name: string; dataType: string; options?: Array<{ id: string; name: string }> }> } } }>(
    appId, installationId, FIELDS_QUERY, { id: projectNodeId });

  const map: FieldMap = {};
  for (const f of data.node?.fields?.nodes ?? []) {
    if (!f?.id || !KNOWN_DATA_TYPES.has(f.dataType)) continue; // unknown types are skipped, never fatal
    const name = f.name.toLowerCase();
    if (!map.start_field && name === "start" && (f.dataType === "DATE" || f.dataType === "ITERATION")) {
      map.start_field = { node_id: f.id, type: f.dataType };
    } else if (!map.target_field && ["target", "target date", "end"].includes(name)
        && (f.dataType === "DATE" || f.dataType === "ITERATION")) {
      map.target_field = { node_id: f.id, type: f.dataType };
    } else if (!map.status_field && name === "status" && f.dataType === "SINGLE_SELECT") {
      const options: Record<string, string> = {};
      for (const o of f.options ?? []) {
        const mapped = STATUS_OPTION_MAP[o.name.toLowerCase()];
        if (mapped !== undefined && options[mapped] === undefined) options[mapped] = o.id;
      }
      map.status_field = { node_id: f.id, type: "SINGLE_SELECT", options };
    }
    if (!map.iteration_field && f.dataType === "ITERATION") {
      map.iteration_field = { node_id: f.id };
    }
  }
  return map;
}
