const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || "8080", 10);

const dbConfig = {
  host: process.env.DB_HOST || "db",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  user: process.env.DB_USER || "jobdash",
  password: process.env.DB_PASS || "jobdashpass",
  database: process.env.DB_NAME || "jobdash",
  connectionLimit: 10,
  timezone: "Z",
};

// Optional base path for mounting under a sub-path (e.g. /jobdash)
let BASE_PATH = (process.env.BASE_PATH || "").trim();
if (BASE_PATH && !BASE_PATH.startsWith("/")) {
  BASE_PATH = "/" + BASE_PATH;
}
BASE_PATH = BASE_PATH.replace(/\/+$/, "");
if (BASE_PATH === "/") {
  BASE_PATH = "";
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const pool = mysql.createPool(dbConfig);

// ---------- DB bootstrap ----------
async function ensureSchemaAndSeed() {
  const conn = await pool.getConnection();
  try {
    // New schema for job_queue
    await conn.query(
      "CREATE TABLE IF NOT EXISTS job_queue (" +
        "jobID BIGINT PRIMARY KEY," +
        "wo_no_sec VARCHAR(64) NOT NULL," +                        // media order number
        "wo_desc VARCHAR(255) NOT NULL," +                         // media order name/description
        "service_ro_no VARCHAR(64) NULL," +
        "operation_no VARCHAR(64) NULL," +
        "task_desc VARCHAR(255) NULL," +
        "customer_name VARCHAR(255) NULL," +
        "ar_account_rep_account_rep_email VARCHAR(255) NULL," +
        "startTime DATETIME NOT NULL," +
        "endTime DATETIME NULL," +
        "currentWorkflow VARCHAR(255) NULL," +
        "status ENUM('queued','running','success','error','cancelled') NOT NULL DEFAULT 'queued'," +
        "INDEX idx_status (status)," +
        "INDEX idx_startTime (startTime)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    );

    // Seed some example rows if empty
    const [rows] = await conn.query("SELECT COUNT(*) AS c FROM job_queue");
    const count = rows[0] && rows[0].c ? parseInt(rows[0].c, 10) : 0;

    if (count === 0) {
      await conn.query(
        "INSERT INTO job_queue " +
        "(jobID, wo_no_sec, wo_desc, service_ro_no, operation_no, task_desc, customer_name, ar_account_rep_account_rep_email, startTime, endTime, currentWorkflow, status) VALUES " +
        "(10001, 'MO-2025-0001', 'Ingest: ACME Trailer',    'SR-1001', 'OP-10', 'Ingest ProRes Master',      'ACME Studios',   'rep1@example.com', NOW() - INTERVAL 2 HOUR,  NULL,                          'Ingest Workflow',    'running')," +
        "(10002, 'MO-2025-0002', 'QC: ACME Trailer',        'SR-1002', 'OP-20', 'Full QC Pass',             'ACME Studios',   'rep2@example.com', NOW() - INTERVAL 90 MINUTE, NOW() - INTERVAL 70 MINUTE, 'QC Workflow',        'queued')," +
        "(10003, 'MO-2025-0003', 'Transcode: 4K Master',    'SR-1003', 'OP-30', 'Transcode to 4K IMF',      'Megacorp Films', 'rep3@example.com', NOW() - INTERVAL 70 MINUTE, NOW() - INTERVAL 10 MINUTE, 'Transcode Workflow', 'error')," +
        "(10004, 'MO-2025-0004', 'Package: iTunes Deliver', 'SR-1004', 'OP-40', 'Package for iTunes Store', 'Megacorp Films', 'rep4@example.com', NOW() - INTERVAL 30 MINUTE, NULL,                       'Package Workflow',   'success')"
      );
    }
  } finally {
    conn.release();
  }
}

// ---------- Express app ----------
const app = express();

// Serve static assets at root (for direct access)…
app.use(express.static(__dirname));
// …and optionally under the base path, if configured (e.g. /jobdash)
if (BASE_PATH) {
  app.use(BASE_PATH, express.static(__dirname));
}

// Helper to prefix routes with BASE_PATH when needed
function withBase(p) {
  if (!BASE_PATH) return p;
  return BASE_PATH + p;
}

// Health handler
async function healthHandler(_req, res) {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0] && rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

// Jobs handler
async function jobsHandler(req, res) {
  try {
    const status = req.query.status || "";
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "500", 10), 1),
      5000
    );

    let sort = req.query.sort || "startTime:desc";
    let [sortCol, sortDir] = String(sort).split(":");

    // Allow sorting on columns we care about in UI
    const allowed = {
      jobID: 1,
      wo_no_sec: 1,
      wo_desc: 1,
      task_desc: 1,
      startTime: 1,
      endTime: 1,
      currentWorkflow: 1,
      status: 1,
    };

    if (!allowed[sortCol]) sortCol = "startTime";
    sortDir = (sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";

    let sql =
      "SELECT jobID, wo_no_sec, wo_desc, service_ro_no, operation_no, task_desc, " +
      "customer_name, ar_account_rep_account_rep_email, startTime, endTime, currentWorkflow, status " +
      "FROM job_queue ";
    const params = [];

    if (status) {
      sql += "WHERE status = ? ";
      params.push(status);
    }

    sql += "ORDER BY " + sortCol + " " + sortDir + " LIMIT ?";
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

// Delete handler (admin only)
async function deleteJobHandler(req, res) {
  try {
    const token = req.header("x-admin-token") || "";
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid jobID" });
    }

    const [result] = await pool.execute(
      "DELETE FROM job_queue WHERE jobID = ?",
      [id]
    );
    res.json({ ok: true, affectedRows: result.affectedRows || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

// Index handler
function indexHandler(_req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
}

// Register routes for both root and optional BASE_PATH
app.get("/api/health", healthHandler);
app.get("/api/jobs", jobsHandler);
app.delete("/api/jobs/:id", deleteJobHandler);
app.get("/", indexHandler);

if (BASE_PATH) {
  app.get(withBase("/api/health"), healthHandler);
  app.get(withBase("/api/jobs"), jobsHandler);
  app.delete(withBase("/api/jobs/:id"), deleteJobHandler);
  app.get(withBase("/"), indexHandler);
}

// ---------- Startup ----------
ensureSchemaAndSeed()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        "jobdash listening on http://0.0.0.0:" +
          PORT +
          (BASE_PATH ? " (base path: " + BASE_PATH + ")" : "")
      );
    });
  })
  .catch((e) => {
    console.error("Startup error:", e);
    process.exit(1);
  });
