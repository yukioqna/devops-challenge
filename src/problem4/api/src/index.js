const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  port: 5432,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Bug 1 fix: handle idle connection errors to prevent Node.js crash
pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  lazyConnect: true,
  enableOfflineQueue: false, // Bug 3 fix: don't queue commands when disconnected
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

app.get("/api/users", async (req, res) => {
  let db;
  try {
    db = await pool.connect();
    const result = await db.query("SELECT NOW()");

    // Bug 3 fix: Redis is non-critical — fire-and-forget, never block the response
    redis.set("last_call", Date.now()).catch((err) => {
      console.error("Redis set failed (non-fatal):", err.message);
    });

    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    // Bug 4 fix: always release connection, even on error
    if (db) db.release();
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(3000, () => console.log("API running on 3000"));
