import pg from "pg";
import { attachPoolErrorHandler, installProcessGuards } from "@foreman/db";
import { createApp } from "./http.js";

installProcessGuards("mcp");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
attachPoolErrorHandler(pool, "mcp");
const port = Number(process.env.PORT ?? 8811);

createApp(pool).listen(port, () => {
  console.log(`foreman-mcp listening on :${port}`);
});
