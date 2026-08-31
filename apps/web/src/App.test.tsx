import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./App.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("login page", () => {
  it("posts the email to /auth/dev-login and navigates away", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", (async (url: any, init: any) => {
      calls.push({ url: String(url), body: init?.body ?? "" });
      if (String(url).includes("dev-login")) return new Response(JSON.stringify({ user_id: "u1" }), { status: 200 });
      return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
    }) as typeof fetch);

    render(<MemoryRouter initialEntries={["/login"]}><AppRoutes /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText(/email/i), "dev@test.local");
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    const login = calls.find((c) => c.url.includes("/auth/dev-login"));
    expect(login).toBeDefined();
    expect(JSON.parse(login!.body)).toEqual({ email: "dev@test.local" });
  });

  it("shows an error on unknown email", async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    render(<MemoryRouter initialEntries={["/login"]}><AppRoutes /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText(/email/i), "nobody@test.local");
    await userEvent.click(screen.getByRole("button", { name: /log in/i }));
    expect(await screen.findByText(/unknown user/i)).toBeTruthy();
  });
});
