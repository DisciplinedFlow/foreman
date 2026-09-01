import { describe, it, expect } from "vitest";
import {
  extractOpenApi, extractExpress, extractFastApi, extractNextRoutes, detectTests,
  extractDjango, extractRails, extractSpring,
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

describe("extractDjango (deviation: URLconf has no verb → GET)", () => {
  const src = `
from django.urls import path, re_path

urlpatterns = [
    path("users/", views.user_list),
    path("users/<int:pk>/", views.user_detail),
    re_path(r"^legacy/$", views.legacy),
    # path("commented/", views.nope),
]
`;
  it("finds urlpatterns entries with converters mapped to params", () => {
    const found = extractDjango(src);
    const keys = found.map((f) => `${f.method} ${f.path}`);
    expect(keys).toContain("GET /users/");
    expect(keys).toContain("GET /users/:pk/");
    expect(keys).toContain("GET /legacy/");
    expect(keys.some((k) => k.includes("commented"))).toBe(false);
    expect(found.every((f) => f.framework === "django")).toBe(true);
  });
});

describe("extractRails", () => {
  const src = `
Rails.application.routes.draw do
  get "health", to: "health#show"
  post 'webhooks/github', to: "webhooks#github"
  resources :articles
  # get "commented", to: "x#y"
end
`;
  it("finds verb routes and expands resources to the 5 API routes", () => {
    const found = extractRails(src);
    const keys = found.map((f) => `${f.method} ${f.path}`).sort();
    expect(keys).toContain("GET /health");
    expect(keys).toContain("POST /webhooks/github");
    for (const k of ["GET /articles", "POST /articles", "GET /articles/:id", "PATCH /articles/:id", "DELETE /articles/:id"]) {
      expect(keys).toContain(k);
    }
    expect(keys.some((k) => k.includes("commented"))).toBe(false);
    expect(found.length).toBe(7);
  });

  it("expands one level of nested resources to shallow parent-scoped routes", () => {
    const src = `
Rails.application.routes.draw do
  resources :posts do
    resources :comments
  end
end
`;
    const found = extractRails(src);
    const keys = found.map((f) => `${f.method} ${f.path}`).sort();
    expect(keys).toEqual([
      "DELETE /posts/:id",
      "DELETE /posts/:post_id/comments/:id",
      "GET /posts",
      "GET /posts/:id",
      "GET /posts/:post_id/comments",
      "GET /posts/:post_id/comments/:id",
      "PATCH /posts/:id",
      "PATCH /posts/:post_id/comments/:id",
      "POST /posts",
      "POST /posts/:post_id/comments",
    ]);
  });

  it("honours only: to restrict the expanded action set", () => {
    const src = `resources :sessions, only: [:create, :destroy]`;
    const found = extractRails(src);
    const keys = found.map((f) => `${f.method} ${f.path}`).sort();
    expect(keys).toEqual(["DELETE /sessions/:id", "POST /sessions"]);
  });

  it("honours except: to exclude actions from the expanded set", () => {
    const src = `resources :sessions, except: [:destroy]`;
    const found = extractRails(src);
    const keys = found.map((f) => `${f.method} ${f.path}`).sort();
    expect(keys).toEqual([
      "GET /sessions", "GET /sessions/:id", "PATCH /sessions/:id", "POST /sessions",
    ]);
  });
});

describe("extractSpring", () => {
  const src = `
@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping
    public List<Order> list() { return service.all(); }

    @GetMapping("/{id}")
    public Order one(@PathVariable Long id) { return service.get(id); }

    @PostMapping("/{id}/cancel")
    public void cancel(@PathVariable Long id) { service.cancel(id); }

    @RequestMapping(method = RequestMethod.DELETE, value = "/{id}")
    public void remove(@PathVariable Long id) { service.remove(id); }

    // @GetMapping("/commented")
}
`;
  it("joins the class prefix with method mappings, empty path = prefix itself", () => {
    const found = extractSpring(src);
    const keys = found.map((f) => `${f.method} ${f.path}`).sort();
    expect(keys).toEqual([
      "DELETE /api/orders/{id}",
      "GET /api/orders",
      "GET /api/orders/{id}",
      "POST /api/orders/{id}/cancel",
    ]);
  });

  it("parses @RequestMapping argument lists in any order (value-first, method-second)", () => {
    const found = extractSpring(`@RequestMapping(value = "/orders", method = RequestMethod.POST)`);
    const keys = found.map((f) => `${f.method} ${f.path}`);
    expect(keys).toEqual(["POST /orders"]);
  });

  it("accepts the path= alias for @RequestMapping", () => {
    const found = extractSpring(`@RequestMapping(path = "/orders", method = RequestMethod.GET)`);
    const keys = found.map((f) => `${f.method} ${f.path}`);
    expect(keys).toEqual(["GET /orders"]);
  });

  it("joins Kotlin-style @GetMapping with the class prefix (regression guard)", () => {
    const src = `
@RequestMapping("/api")
class ItemController {
    @GetMapping("/items/{id}")
    fun one(@PathVariable id: Long): Item = service.get(id)
}
`;
    const found = extractSpring(src);
    const keys = found.map((f) => `${f.method} ${f.path}`);
    expect(keys).toEqual(["GET /api/items/{id}"]);
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
