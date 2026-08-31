import { registry, EVENT_TYPES, type EventType } from "./registry.js";
export { registry, EVENT_TYPES, type EventType };

export interface NewEvent {
  organisation_id: string;
  project_id?: string;
  agent_id?: string;
  work_item_id?: string;
  run_id?: string;
  type: EventType;
  payload: Record<string, unknown>;
  idempotency_key?: string;
  occurred_at?: Date;
}

export function validateEventPayload(type: string, payload: unknown):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  if (!Object.hasOwn(registry, type)) return { ok: false, error: `unknown event type: ${type}` };
  const schema = (registry as Record<string, import("zod").ZodTypeAny>)[type]!;
  const r = schema.safeParse(payload);
  return r.success
    ? { ok: true, payload: r.data as Record<string, unknown> }
    : { ok: false, error: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
