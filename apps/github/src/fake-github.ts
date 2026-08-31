import express from "express";

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
}

// Minimal GitHub stand-in for the round-trip test: token mint, GraphQL canned by
// query substring, REST echoing ids. Records every request.
export async function startFakeGithub(): Promise<{ url: string; requests: RecordedRequest[]; close(): Promise<unknown> }> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json({ type: "*/*" }));
  app.use((req, _res, next) => { requests.push({ method: req.method, path: req.path, body: req.body }); next(); });

  app.post("/app/installations/:id/access_tokens", (_req, res) => {
    res.status(201).json({ token: "ghs_fake", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  });

  app.post("/graphql", (req, res) => {
    const q: string = req.body?.query ?? "";
    if (q.includes("updateProjectV2ItemFieldValue")) {
      return res.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: req.body?.variables?.itemId ?? "ITEM_1" } } } });
    }
    if (q.includes("items(")) {
      return res.json({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    if (q.includes("fields(")) {
      return res.json({ data: { node: { fields: { nodes: [] } } } });
    }
    return res.json({ data: {} });
  });

  let issueSeq = 1000;
  app.post("/repos/:owner/:repo/issues", (req, res) => {
    issueSeq += 1;
    res.status(201).json({ id: issueSeq, node_id: `I_fake_${issueSeq}`, number: issueSeq - 1000 });
  });
  app.post("/repos/:owner/:repo/issues/:n/sub_issues", (_req, res) => res.status(201).json({}));
  app.post("/repos/:owner/:repo/issues/:n/dependencies/blocked_by", (_req, res) => res.status(201).json({}));
  app.get("/repos/:owner/:repo/issues/:n/dependencies/blocked_by", (_req, res) => res.status(200).json([]));

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
