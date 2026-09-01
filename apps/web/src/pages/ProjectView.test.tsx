import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Minimal EventSource stand-in — useProjectStream only touches onmessage/close.
class FakeEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

function fakeMatchMedia(matches: boolean) {
  return (query: string): MediaQueryList => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList);
}

function stubProjectFetch() {
  vi.stubGlobal("fetch", (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.endsWith("/api/projects/p1")) return json({ project: { name: "Test project" } });
    if (u.includes("/items")) return json({ items: [], deps: [] });
    if (u.includes("/schedule")) return json({ schedule: [] });
    if (u.includes("/comm-graph")) return json({ nodes: [], edges: [] });
    if (u.includes("/agents")) return json({ agents: [] });
    if (u.includes("/checkpoints")) return json({ checkpoints: [] });
    return json({});
  }) as typeof fetch);
}

async function renderProject() {
  stubProjectFetch();
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  render(<MemoryRouter initialEntries={["/projects/p1"]}><AppRoutes /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Toggle navigation" })).toBeTruthy());
}

describe("ProjectView mobile rail drawer (a11y)", () => {
  it("is inert while closed on mobile, and interactive once opened", async () => {
    vi.stubGlobal("matchMedia", fakeMatchMedia(true));
    await renderProject();

    const rail = document.querySelector("aside.rail") as HTMLElement & { inert: boolean };
    expect(rail.inert).toBe(true); // closed by default — off-screen controls must not be tabbable

    await userEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    expect(rail.inert).toBe(false);
  });

  it("contains focus in the drawer while open, and returns it to the hamburger on close", async () => {
    vi.stubGlobal("matchMedia", fakeMatchMedia(true));
    await renderProject();

    const hamburger = screen.getByRole("button", { name: "Toggle navigation" });
    const contentCol = screen.getByTestId("content-col") as HTMLElement & { inert: boolean };

    await userEvent.click(hamburger);
    // Opening moves focus into the rail (first focusable — the workspace switcher link).
    expect(document.activeElement?.closest("aside.rail")).not.toBeNull();
    expect(contentCol.inert).toBe(true); // content behind the scrim is unreachable while open

    await userEvent.keyboard("{Escape}");
    expect(contentCol.inert).toBe(false);
    expect(document.activeElement).toBe(hamburger); // focus restored to the trigger
  });

  it("stays fully interactive on desktop (rail never goes inert)", async () => {
    vi.stubGlobal("matchMedia", fakeMatchMedia(false));
    await renderProject();
    const rail = document.querySelector("aside.rail") as HTMLElement & { inert: boolean };
    expect(rail.inert).toBe(false);
  });
});
