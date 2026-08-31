import { describe, it, expect } from "vitest";
import {
  extractOpenApi, extractExpress, extractFastApi, extractNextRoutes, detectTests,
} from "./extract.js";

describe("extractOpenApi (LFC-1)", () => {
  it("reads JSON specs", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": { get: {}, post: {} },
        "/users/{id}": { delete: {} },
      },
    });
    const found = extractOpenApi(spec);
    expect(found.map((f) => `${f.method} ${f.path}`).sort()).toEqual(
      ["DELETE /users/{id}", "GET /users", "POST /users"]);
    expect(found.every((f) => f.source === "spec")).toBe(true);
  });

  it("reads YAML specs via the indentation walk", () => {
    const yaml = [
      "openapi: 3.0.0",
      "paths:",
      "  /orders:",
      "    get:",
      "      summary: list",
      "    post:",
      "      summary: create",
      "  /orders/{id}:",
      "    get:",
      "      summary: one",
      "components:",
      "  schemas: {}",
    ].join("\n");
    const found = extractOpenApi(yaml);
    expect(found.map((f) => `${f.method} ${f.path}`).sort()).toEqual(
      ["GET /orders", "GET /orders/{id}", "POST /orders"]);
  });
});

describe("extractExpress", () => {
  const src = `
    import express from "express";
    const app = express();
    app.get('/health', (req, res) => res.json({ ok: true }));
    app.post("/users", async (req, res) => {
      const user = await createUser(req.body);
      await audit(user);
      res.status(201).json(user);
    });
    router.delete('/users/:id', (req, res) => { throw new NotImplemented(); });
    // app.get('/commented-out', handler)  <- still a route call on this line? no: comment
    const s = "app.get('/not-a-route'";
  `;
  it("finds routes and flags trivial handlers", () => {
    const found = extractExpress(src);
    const byPath = Object.fromEntries(found.map((f) => [`${f.method} ${f.path}`, f]));
    expect(byPath["GET /health"]!.trivial).toBe(true);
    expect(byPath["POST /users"]!.trivial).toBe(false);
    expect(byPath["DELETE /users/:id"]!.trivial).toBe(true);
    expect(found.length).toBe(3); // string literal decoy not matched (no closing quote+paren shape)
  });
});

describe("extractFastApi", () => {
  const src = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
def list_items():
    return db.query(Item).all()

@router.post("/items")
def create_item(item: Item):
    pass

@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    raise NotImplementedError
`;
  it("finds decorated routes and flags trivial bodies", () => {
    const found = extractFastApi(src);
    const byPath = Object.fromEntries(found.map((f) => [`${f.method} ${f.path}`, f]));
    expect(byPath["GET /items"]!.trivial).toBe(false);
    expect(byPath["POST /items"]!.trivial).toBe(true);
    expect(byPath["DELETE /items/{item_id}"]!.trivial).toBe(true);
  });
});

describe("extractNextRoutes", () => {
  it("derives the path from the file location and finds exported methods", () => {
    const found = extractNextRoutes("app/api/users/[id]/route.ts", `
      export async function GET(req: Request) { return Response.json(await load()); }
      export const POST = async () => new Response(null, { status: 201 });
      // export function DELETE() {} — commented out should still match? it is text: acceptable v1
      function helper() {}
    `);
    const keys = found.map((f) => `${f.method} ${f.path}`);
    expect(keys).toContain("GET /api/users/:id");
    expect(keys).toContain("POST /api/users/:id");
    expect(keys.every((k) => !k.includes("helper"))).toBe(true);
  });
});

describe("detectTests", () => {
  it("marks endpoints referenced by test content", () => {
    const eps = [
      { method: "GET", path: "/users", source: "impl" as const },
      { method: "GET", path: "/orders", source: "impl" as const },
    ];
    const hits = detectTests(`it("lists users", () => request(app).get("/users").expect(200))`, eps);
    expect(hits).toEqual(["/users"]);
  });
});
