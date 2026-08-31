import { describe, it, expect } from "vitest";
import { discoverFieldMap } from "./field-map.js";

const fixture = {
  node: {
    fields: {
      nodes: [
        { id: "F_status", name: "Status", dataType: "SINGLE_SELECT",
          options: [{ id: "opt_todo", name: "Todo" }, { id: "opt_prog", name: "In Progress" }, { id: "opt_done", name: "Done" }] },
        { id: "F_start", name: "Start", dataType: "ITERATION",
          configuration: { duration: 14, startDay: 1, iterations: [] } },
        { id: "F_target", name: "Target", dataType: "DATE" },
        { id: "F_sprint", name: "Sprint", dataType: "ITERATION" },
        { id: "F_weird", name: "Weird", dataType: "SOME_FUTURE_TYPE" },
      ],
    },
  },
};

describe("discoverFieldMap", () => {
  it("maps Status/Start/Target/Sprint to the §5.3 shape, skipping unknown dataTypes", async () => {
    const gh = { graphql: (async () => fixture) as any, rest: async () => ({ status: 200, json: {} }) };
    const map = await discoverFieldMap(gh, 1, 777, "PVT_x");
    expect(map).toEqual({
      start_field: { node_id: "F_start", type: "ITERATION" },
      target_field: { node_id: "F_target", type: "DATE" },
      status_field: {
        node_id: "F_status", type: "SINGLE_SELECT",
        options: { queued: "opt_todo", in_progress: "opt_prog", done: "opt_done" },
      },
      iteration_field: { node_id: "F_start" },
    });
  });

  it("omits keys for absent fields (caller treats absence as don't-sync)", async () => {
    const gh = { graphql: (async () => ({ node: { fields: { nodes: [{ id: "F_t", name: "Title", dataType: "TITLE" }] } } })) as any,
      rest: async () => ({ status: 200, json: {} }) };
    const map = await discoverFieldMap(gh, 1, 777, "PVT_x");
    expect(map).toEqual({});
  });
});
