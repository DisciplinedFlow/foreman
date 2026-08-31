import type pg from "pg";
import type { Queryable } from "@foreman/db";

// The authorisation layer: every user-facing read runs as foreman_app with the
// app.user_id GUC set LOCAL to one transaction. RLS scopes rows; SQL never does.
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
