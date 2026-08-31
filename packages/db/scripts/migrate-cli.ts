// Dev bootstrap: create the `foreman` database if missing, run all migrations.
// Usage: pnpm db:migrate   (DATABASE_URL_ADMIN overrides the superuser conn)
import pg from "pg";
import { migrate } from "../src/migrate.js";

const admin = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@localhost:5433/postgres";
const dbName = process.env.FOREMAN_DB_NAME ?? "foreman";

const root = new pg.Client({ connectionString: admin });
await root.connect();
const exists = await root.query("select 1 from pg_database where datname = $1", [dbName]);
if (exists.rowCount === 0) {
  await root.query(`create database ${dbName}`);
  console.log(`created database ${dbName}`);
}
await root.end();

const url = new URL(admin);
url.pathname = `/${dbName}`;
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const applied = await migrate(client);
await client.end();
console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "migrations already up to date");
