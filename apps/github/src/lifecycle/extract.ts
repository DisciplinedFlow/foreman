// LFC-1 extractors (Phase 6 deviation 1): structural line parsers over
// API-fetched file contents. X-6: file contents are untrusted — parse only,
// never execute; paths are length-capped and must be absolute.

export interface Found {
  method: string;
  path: string;
  source: "spec" | "impl";
  framework?: string;
  trivial?: boolean;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const MAX_PATH = 200;

const validPath = (p: string): boolean => p.startsWith("/") && p.length <= MAX_PATH;

const isCommentLine = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("#");
};

export function extractOpenApi(content: string): Found[] {
  const out: Found[] = [];
  const push = (method: string, path: string) => {
    if (validPath(path)) out.push({ method: method.toUpperCase(), path, source: "spec" });
  };

  // JSON first
  try {
    const doc = JSON.parse(content) as { paths?: Record<string, Record<string, unknown>> };
    if (doc.paths !== undefined) {
      for (const [path, ops] of Object.entries(doc.paths)) {
        for (const method of Object.keys(ops)) if (METHODS.has(method)) push(method, path);
      }
      return out;
    }
  } catch { /* fall through to YAML */ }

  // YAML-lite indentation walk: `paths:` at column 0, path keys at one indent,
  // method keys at the next.
  const lines = content.split("\n");
  let inPaths = false;
  let currentPath: string | null = null;
  let pathIndent = -1;
  for (const line of lines) {
    if (line.trim() === "" || isCommentLine(line)) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.trim().replace(/:.*$/, "").trim();
    if (indent === 0) {
      inPaths = key === "paths";
      currentPath = null;
      continue;
    }
    if (!inPaths) continue;
    if (key.startsWith("/")) {
      currentPath = key;
      pathIndent = indent;
    } else if (currentPath !== null && indent > pathIndent && METHODS.has(key)) {
      push(key, currentPath);
    }
  }
  return out;
}

const EXPRESS_RE = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/;

export function extractExpress(content: string): Found[] {
  const out: Found[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;
    const m = EXPRESS_RE.exec(line);
    if (m === null) continue;
    const method = (m[1] === "all" ? "get" : m[1]!).toUpperCase();
    const path = m[2]!;
    if (!validPath(path)) continue;
    const sameLineClosed = /\)\s*;?\s*$/.test(line.trim()) && !line.trim().endsWith("{");
    const lookahead = lines.slice(i, i + 4).join("\n");
    const trivial = sameLineClosed || /NotImplemented|TODO\b/.test(lookahead);
    out.push({ method, path, source: "impl", framework: "express", trivial });
  }
  return out;
}

const FASTAPI_RE = /^\s*@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/;

export function extractFastApi(content: string): Found[] {
  const out: Found[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = FASTAPI_RE.exec(lines[i]!);
    if (m === null) continue;
    const path = m[2]!;
    if (!validPath(path)) continue;
    // body = the lines after the following `def`
    let trivial = false;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const t = lines[j]!.trim();
      if (t === "pass" || t.startsWith("raise NotImplementedError")) { trivial = true; break; }
      if (t.startsWith("return ") || (t !== "" && !t.startsWith("def ") && !t.startsWith("@") && !t.endsWith(":"))) break;
    }
    out.push({ method: m[1]!.toUpperCase(), path, source: "impl", framework: "fastapi", trivial });
  }
  return out;
}

const NEXT_EXPORT_RE = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

export function extractNextRoutes(filePath: string, content: string): Found[] {
  if (!/(^|\/)app\/.*route\.(ts|tsx|js|jsx)$/.test(filePath)) return [];
  const routePath = "/" + filePath
    .replace(/^.*?app\//, "")
    .replace(/\/route\.(ts|tsx|js|jsx)$/, "")
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))) // route groups
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"))
    .join("/");
  if (!validPath(routePath)) return [];
  const out: Found[] = [];
  const clean = content.split("\n").filter((l) => !isCommentLine(l)).join("\n");
  for (const m of clean.matchAll(NEXT_EXPORT_RE)) {
    out.push({ method: m[1]!, path: routePath, source: "impl", framework: "next", trivial: false });
  }
  return out;
}

export function detectTests(content: string, endpoints: Array<Pick<Found, "method" | "path">>): string[] {
  const hit = new Set<string>();
  for (const e of endpoints) {
    if (e.path.length >= 4 && content.includes(e.path)) hit.add(e.path);
  }
  return [...hit].sort();
}
