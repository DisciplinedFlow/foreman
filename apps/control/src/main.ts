import pg from "pg";
import { attachPoolErrorHandler, installProcessGuards } from "@foreman/db";
import { createControlApp } from "./http.js";

installProcessGuards("control");

const token = process.env.FOREMAN_CONTROL_TOKEN;
if (!token) throw new Error("FOREMAN_CONTROL_TOKEN is required");

const pool = new pg.Pool({
  connectionString: process.env.FOREMAN_CONTROL_DATABASE_URL
    ?? "postgres://foreman_control:foreman_control@localhost:5433/foreman",
});
attachPoolErrorHandler(pool, "control");

const port = Number(process.env.FOREMAN_CONTROL_PORT ?? 3006);
createControlApp({ pool, token }).listen(port, () => {
  console.log(`foreman-control on :${port}`);
});
