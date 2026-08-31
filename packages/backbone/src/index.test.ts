import { describe, it, expect } from "vitest";
import {
  Backbone,
  BackboneEvent,
  NewWorkItem,
  ProjectRef,
  Schedule,
  Unsubscribe,
  WorkItem,
  WorkItemRef,
  RunStatus,
} from "./index.js";

/**
 * FakeBackbone: in-memory implementation for contract testing.
 * Pins the Backbone interface by implementing it concretely.
 */
class FakeBackbone implements Backbone {
  private items: WorkItem[] = [];
  private handlers: ((e: BackboneEvent) => void)[] = [];
  private nextId = 1;

  async listWorkItems(
    _project: ProjectRef,
    since?: Date
  ): Promise<WorkItem[]> {
    if (since) {
      // Filter by since (simplified; in real impl would track timestamps)
      return this.items;
    }
    return this.items;
  }

  async createWorkItem(
    _project: ProjectRef,
    item: NewWorkItem
  ): Promise<WorkItem> {
    const workItem: WorkItem = {
      ...item,
      workItemId: `work-item-${this.nextId++}`,
      status: "open",
    };
    this.items.push(workItem);
    this.emit({ kind: "work_item_changed", item: workItem });
    return workItem;
  }

  async updateSchedule(item: WorkItemRef, s: Schedule): Promise<void> {
    const found = this.items.find((w) => w.workItemId === item.workItemId);
    if (found) {
      this.emit({ kind: "schedule_changed", item, schedule: s });
    }
  }

  async linkParent(
    child: WorkItemRef,
    parent: WorkItemRef
  ): Promise<void> {
    // Simplified: just a no-op for contract testing
  }

  async addDependency(
    blocked: WorkItemRef,
    blocker: WorkItemRef
  ): Promise<void> {
    this.emit({
      kind: "dependency_changed",
      blocked,
      blocker,
      removed: false,
    });
  }

  async reportRun(_item: WorkItemRef, _run: RunStatus): Promise<void> {
    // Simplified: just a no-op for contract testing
  }

  subscribe(handler: (e: BackboneEvent) => void): Unsubscribe {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) {
        this.handlers.splice(idx, 1);
      }
    };
  }

  private emit(event: BackboneEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

describe("Backbone contract", () => {
  it("createWorkItem appears in listWorkItems", async () => {
    const backbone = new FakeBackbone();
    const project: ProjectRef = { projectId: "proj-1" };
    const newItem: NewWorkItem = {
      title: "Test task",
      kind: "task",
    };

    const created = await backbone.createWorkItem(project, newItem);
    expect(created.workItemId).toBeDefined();
    expect(created.title).toBe("Test task");
    expect(created.status).toBe("open");

    const listed = await backbone.listWorkItems(project);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.workItemId).toBe(created.workItemId);
  });

  it("subscribe fires on createWorkItem", async () => {
    const backbone = new FakeBackbone();
    const project: ProjectRef = { projectId: "proj-1" };
    const newItem: NewWorkItem = {
      title: "Another task",
      kind: "story",
    };

    const events: BackboneEvent[] = [];
    const unsubscribe = backbone.subscribe((e) => events.push(e));

    const created = await backbone.createWorkItem(project, newItem);

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("work_item_changed");
    if (events[0]!.kind === "work_item_changed") {
      expect(events[0]!.item.workItemId).toBe(created.workItemId);
      expect(events[0]!.item.title).toBe("Another task");
    }

    // Unsubscribe and create another; should not fire
    unsubscribe();
    const newItem2: NewWorkItem = { title: "Third task" };
    await backbone.createWorkItem(project, newItem2);

    expect(events).toHaveLength(1); // Still 1, not 2
  });

  it("unsubscribe stops events", async () => {
    const backbone = new FakeBackbone();
    const project: ProjectRef = { projectId: "proj-2" };

    const workItemEvents: WorkItem[] = [];
    const unsubscribe = backbone.subscribe((e) => {
      if (e.kind === "work_item_changed") {
        workItemEvents.push(e.item);
      }
    });

    // Create one item
    await backbone.createWorkItem(project, { title: "First" });
    expect(workItemEvents).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    // Create another; should not fire
    await backbone.createWorkItem(project, { title: "Second" });
    expect(workItemEvents).toHaveLength(1);
  });
});
