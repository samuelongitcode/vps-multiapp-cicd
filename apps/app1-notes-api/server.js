// Minimal Notes API - demonstrates an app using the SHARED postgres AND
// shared redis instances, isolated purely by database name / key prefix +
// ACL credentials (no separate postgres or redis container per app).
const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || "postgres",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Connects with a Redis ACL user that can only touch keys under REDIS_PREFIX:*
// (enforced server-side by the ACL, not just by convention here).
const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USER,
  password: process.env.REDIS_PASSWORD,
});
const prefix = process.env.REDIS_PREFIX || "app1";
const countKey = `${prefix}:notes_count`;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/notes", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM notes ORDER BY id DESC");
  res.json(rows);
});

app.post("/notes", async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: "content is required" });
  const { rows } = await pool.query(
    "INSERT INTO notes (content) VALUES ($1) RETURNING *",
    [content]
  );
  await redis.incr(countKey); // shared redis, but this app can only ever touch "app1:*" keys
  res.status(201).json(rows[0]);
});

// Cached count, backed by redis - shows the shared cache working alongside
// the shared postgres database in the same request lifecycle.
app.get("/notes/count", async (req, res) => {
  let cached = await redis.get(countKey);
  if (cached === null) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM notes");
    cached = rows[0].count;
    await redis.set(countKey, cached, "EX", 60);
  }
  res.json({ count: Number(cached) });
});

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, () => console.log(`app1-notes-api listening on ${port}`)))
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });
