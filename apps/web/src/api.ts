import { useEffect, useRef } from "react";

export class ApiError extends Error {
  constructor(public status: number) {
    super(`api error ${status}`);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<T>;
}

export const patchSchedule = (itemId: string, body: { start_at?: string; target_at?: string }) =>
  api<{ queued: boolean }>(`/api/items/${itemId}/schedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// One SSE stream per open project (§7); frames are invalidation deltas and the
// caller refetches the named scopes. EventSource reconnects itself with the
// browser-managed Last-Event-ID.
export function useProjectStream(projectId: string, onInvalidate: (scopes: string[]) => void): void {
  const cb = useRef(onInvalidate);
  cb.current = onInvalidate;
  useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/stream`);
    es.onmessage = (e) => {
      try {
        const { scopes } = JSON.parse(e.data) as { scopes: string[] };
        cb.current(scopes);
      } catch { /* malformed frame: ignore */ }
    };
    return () => es.close();
  }, [projectId]);
}
