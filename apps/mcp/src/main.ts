import pg from "pg";
import { createApp } from "./http.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 8811);

createApp(pool).listen(port, () => {
  console.log(`foreman-mcp listening on :${port}`);
});
