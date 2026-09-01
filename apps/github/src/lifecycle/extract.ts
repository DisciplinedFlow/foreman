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

// Django URLconf carries no HTTP verb (Phase 7 deviation: emit GET as the
// documented convention); <type:name> converters become :name params.
const DJANGO_RE = /\b(?:path|re_path|url)\(\s*r?['"]([^'"]*)['"]/;

export function extractDjango(content: string): Found[] {
  const out: Found[] = [];
  let inPatterns = false;
  for (const line of content.split("\n")) {
    if (isCommentLine(line)) continue;
    if (/urlpatterns\s*[=+]/.test(line)) inPatterns = true;
    if (!inPatterns) continue;
    const m = DJANGO_RE.exec(line);
    if (m === null) continue;
    let p = m[1]!.replace(/^\^/, "").replace(/\$$/, "");
    p = p.replace(/<\w+:(\w+)>/g, ":$1").replace(/<(\w+)>/g, ":$1");
    const path = p.startsWith("/") ? p : `/${p}`;
    if (!validPath(path)) continue;
    out.push({ method: "GET", path, source: "impl", framework: "django", trivial: false });
    if (/\]/.test(line) && !line.includes("[")) inPatterns = false;
  }
  return out;
}

// Rails routes DSL (Phase 7 deviation 3): verb lines + `resources` expanded to
// the five API routes (new/edit have no API meaning). Phase 9 deviation 4:
// one level of `resources ... do ... end` nesting (Rails' own shallow
// convention — deeper nesting still resolves against the immediate parent
// only), plus `only:`/`except:` symbol-array filtering of the action set.
const RAILS_VERB_RE = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/;
const RAILS_RESOURCES_RE = /^\s*resources\s+:(\w+)(.*)$/;

// index/show are collection+member GET; the other three are POST/PATCH/DELETE.
const RAILS_ACTIONS = ["index", "create", "show", "update", "destroy"] as const;
type RailsAction = (typeof RAILS_ACTIONS)[number];
const RAILS_ACTION_ROUTE: Record<RailsAction, { method: string; member: boolean }> = {
  index: { method: "GET", member: false },
  create: { method: "POST", member: false },
  show: { method: "GET", member: true },
  update: { method: "PATCH", member: true },
  destroy: { method: "DELETE", member: true },
};

// Naive singularization (strip a trailing `s`) — good enough for the plural
// resource names Rails scaffolding conventionally uses.
const singularize = (name: string): string => name.endsWith("s") ? name.slice(0, -1) : name;

const isRailsAction = (a: string): a is RailsAction => (RAILS_ACTIONS as readonly string[]).includes(a);

// `only:`/`except:` accept either a bracketed symbol array (`only: [:a, :b]`)
// or Rails' bare single-symbol shorthand (`only: :a`) — both are recognized.
const RAILS_ONLY_BRACKET_RE = /\bonly:\s*\[([^\]]*)\]/;
const RAILS_ONLY_BARE_RE = /\bonly:\s*:(\w+)\b/;
const RAILS_EXCEPT_BRACKET_RE = /\bexcept:\s*\[([^\]]*)\]/;
const RAILS_EXCEPT_BARE_RE = /\bexcept:\s*:(\w+)\b/;

function railsActionSet(rest: string): Set<RailsAction> {
  const parseList = (list: string): RailsAction[] =>
    [...list.matchAll(/:(\w+)/g)].map((m) => m[1]!).filter(isRailsAction);

  const onlyBracket = RAILS_ONLY_BRACKET_RE.exec(rest);
  if (onlyBracket !== null) return new Set(parseList(onlyBracket[1]!));
  const onlyBare = RAILS_ONLY_BARE_RE.exec(rest);
  if (onlyBare !== null) return new Set(isRailsAction(onlyBare[1]!) ? [onlyBare[1]!] : []);

  const set = new Set<RailsAction>(RAILS_ACTIONS);
  const exceptBracket = RAILS_EXCEPT_BRACKET_RE.exec(rest);
  if (exceptBracket !== null) { for (const a of parseList(exceptBracket[1]!)) set.delete(a); return set; }
  const exceptBare = RAILS_EXCEPT_BARE_RE.exec(rest);
  if (exceptBare !== null && isRailsAction(exceptBare[1]!)) set.delete(exceptBare[1]!);
  return set;
}

export function extractRails(content: string): Found[] {
  const out: Found[] = [];
  const push = (method: string, path: string) => {
    if (validPath(path)) out.push({ method, path, source: "impl", framework: "rails", trivial: false });
  };
  const pushResource = (name: string, actions: Set<RailsAction>, parentSegment: string | null) => {
    const base = parentSegment !== null ? `/${parentSegment}/${name}` : `/${name}`;
    for (const action of RAILS_ACTIONS) {
      if (!actions.has(action)) continue;
      const { method, member } = RAILS_ACTION_ROUTE[action];
      push(method, member ? `${base}/:id` : base);
    }
  };
  // Generic `do`/`end` depth counter, plus a stack of {name, depth} entries
  // pushed only by `resources ... do` (per the brief: "only resources ... do
  // pushes"). A resources entry is popped when a matching `end` returns the
  // depth to the level at which it was opened — so unrelated do/end blocks
  // (member/collection/namespace/etc.) nested inside don't mis-pop it, and
  // only the immediate parent (stack top) is ever used for nesting.
  // Trailing `#`-comments are stripped before the do/end-anchor checks below
  // (e.g. `resources :posts do # nested` must still be recognized as a block
  // opener). Ruby string literals containing `#` on a routes line are out of
  // scope for this simple strip.
  const stripComment = (s: string): string => s.replace(/#.*$/, "").trim();
  let depth = 0;
  const resourceStack: Array<{ name: string; depth: number }> = [];
  for (const rawLine of content.split("\n")) {
    if (isCommentLine(rawLine)) continue;
    const res = RAILS_RESOURCES_RE.exec(rawLine);
    if (res !== null) {
      const name = res[1]!;
      const rest = res[2]!;
      const actions = railsActionSet(rest);
      const parent = resourceStack[resourceStack.length - 1];
      const parentSegment = parent !== undefined ? `${parent.name}/:${singularize(parent.name)}_id` : null;
      pushResource(name, actions, parentSegment);
      if (/\bdo$/.test(stripComment(rest))) {
        depth += 1;
        resourceStack.push({ name, depth });
      }
      continue;
    }
    const verb = RAILS_VERB_RE.exec(rawLine);
    if (verb !== null) {
      const p = verb[2]!;
      push(verb[1]!.toUpperCase(), p.startsWith("/") ? p : `/${p}`);
      continue;
    }
    if (/\bdo$/.test(stripComment(rawLine))) { depth += 1; continue; }
    if (/^end$/.test(stripComment(rawLine))) {
      const top = resourceStack[resourceStack.length - 1];
      if (top !== undefined && top.depth === depth) resourceStack.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

// Spring annotations (Phase 7 deviation 4): class-level @RequestMapping prefix
// + per-method mappings; {id} path variables kept verbatim. Phase 9 deviation
// 5: @RequestMapping's own argument list is scanned rather than matched by a
// single rigid regex, so `value=`/`path=`/bare-string and `method =
// RequestMethod.X` (including a braced multi-method array, `method =
// {RequestMethod.GET, RequestMethod.POST}`) are accepted in any order. Only a
// line with NO `method` arg at all is treated as the class-level prefix —
// a method mapping whose method couldn't be parsed is skipped outright
// rather than corrupting the prefix (regression fixed in Phase 9 review).
const SPRING_METHOD_RE = /@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["']\s*\))?/;
const SPRING_REQMAP_RE = /@RequestMapping\(([^)]*)\)/;

function parseSpringRequestMappingArgs(
  argList: string,
): { path: string | null; methods: string[]; hasMethodArg: boolean } {
  // The `method` arg is pulled out of the raw string *before* splitting on
  // comma, because a multi-method array — `method = {RequestMethod.GET,
  // RequestMethod.POST}` — has its own internal comma that would otherwise
  // split it into two unparseable fragments (Phase 9 regression: that used
  // to leave `method` null while a path was still found, and the caller
  // mistook the line for a class-level prefix, corrupting it for every
  // @GetMapping below). `hasMethodArg` reports whether *any* `method` key
  // was present, parseable or not, so the caller can tell "this is a
  // method mapping with a method we couldn't parse" from "this really is
  // just a class-level prefix".
  const methodMatch = /\bmethod\s*=\s*(\{[^}]*\}|RequestMethod\.[A-Z]+)/.exec(argList);
  const hasMethodArg = methodMatch !== null;
  const methods: string[] = [];
  let rest = argList;
  if (methodMatch !== null) {
    rest = argList.slice(0, methodMatch.index) + argList.slice(methodMatch.index + methodMatch[0].length);
    for (const m of methodMatch[1]!.matchAll(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g)) {
      methods.push(m[1]!);
    }
  }

  let path: string | null = null;
  for (const rawArg of rest.split(",")) {
    const arg = rawArg.trim();
    if (arg === "") continue;
    const named = /^(?:value|path)\s*=\s*["']([^"']*)["']$/.exec(arg);
    if (named !== null) { path = named[1]!; continue; }
    const bare = /^["']([^"']*)["']$/.exec(arg);
    if (bare !== null) { path = bare[1]!; continue; }
  }
  return { path, methods, hasMethodArg };
}

export function extractSpring(content: string): Found[] {
  const out: Found[] = [];
  const lines = content.split("\n").filter((l) => !isCommentLine(l));
  let prefix = "";
  const push = (method: string, sub: string) => {
    const joined = `${prefix}${sub === "" ? "" : sub.startsWith("/") ? sub : `/${sub}`}` || "/";
    if (validPath(joined)) out.push({ method, path: joined, source: "impl", framework: "spring", trivial: false });
  };
  for (const line of lines) {
    const rm = SPRING_REQMAP_RE.exec(line);
    if (rm !== null) {
      const { path, methods, hasMethodArg } = parseSpringRequestMappingArgs(rm[1]!);
      if (!hasMethodArg) {
        // Only a @RequestMapping with NO method argument at all sets the
        // class-level prefix — a method mapping we failed to parse must
        // never be mistaken for one (that's the bug this guards against).
        if (path !== null) prefix = path.replace(/\/$/, "");
        continue;
      }
      for (const method of methods) push(method, path ?? "");
      continue;
    }
    const mm = SPRING_METHOD_RE.exec(line);
    if (mm !== null) push(mm[1]!.toUpperCase(), mm[2] ?? "");
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
