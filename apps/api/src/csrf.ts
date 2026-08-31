import crypto from "node:crypto";
import type express from "express";

export const CSRF_COOKIE = "fmn_csrf";

export function issueCsrf(): string {
  return crypto.randomBytes(32).toString("hex");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// WL-5: double-submit CSRF + Origin validation on every /api mutation. Reads
// stay header-free; bearer-token surfaces (mcp/ingest/webhooks) are elsewhere.
export function csrfMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

    const origin = req.headers.origin;
    if (typeof origin === "string") {
      let host: string | null = null;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host === null || host !== req.headers.host) {
        return res.status(403).json({ error: "cross-origin request rejected" });
      }
    }

    const fromCookie = cookieValue(req.headers.cookie, CSRF_COOKIE);
    const fromHeader = req.headers["x-csrf-token"];
    if (typeof fromHeader !== "string" || fromCookie === undefined) {
      return res.status(403).json({ error: "csrf token required" });
    }
    const a = Buffer.from(fromCookie);
    const b = Buffer.from(fromHeader);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "csrf token mismatch" });
    }
    return next();
  };
}
