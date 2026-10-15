import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, sanitizeJob } from '../domain/job.js';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, config TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS searches(batch_id TEXT NOT NULL REFERENCES batches(id), keyword TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, PRIMARY KEY(batch_id,keyword));
      CREATE TABLE IF NOT EXISTS jobs(batch_id TEXT NOT NULL REFERENCES batches(id), platform TEXT NOT NULL, job_id TEXT NOT NULL, data TEXT NOT NULL, collected_at TEXT NOT NULL, detail_attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id,platform,job_id));
      CREATE TABLE IF NOT EXISTS origins(batch_id TEXT NOT NULL, job_id TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY(batch_id,job_id,keyword));
      CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL, data TEXT NOT NULL, captured_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createBatch(config) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,NULL)').run(id, JSON.stringify(config), 'running', now, now);
    return id;
  }
  batch(id) {
    const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
    if (!row) throw new Error(`找不到批次 ${id}`);
    return { ...row, config: JSON.parse(row.config) };
  }
  batches() { return this.db.prepare('SELECT id,status,created_at,updated_at,reason FROM batches ORDER BY created_at DESC').all(); }
  setStatus(id, status, reason = null) {
    this.db.prepare('UPDATE batches SET status=?,updated_at=?,reason=? WHERE id=?').run(status, new Date().toISOString(), reason, id);
  }
  search(id, keyword) { return this.db.prepare('SELECT * FROM searches WHERE batch_id=? AND keyword=?').get(id, keyword); }
  setSearch(id, keyword, url, status, reason = null) {
    this.db.prepare('INSERT INTO searches VALUES(?,?,?,?,?) ON CONFLICT(batch_id,keyword) DO UPDATE SET url=excluded.url,status=excluded.status,reason=excluded.reason').run(id, keyword, url, status, reason);
  }
  saveJob(batchId, input, { keyword = null, kind = 'list', attempted = false } = {}) {
    const job = sanitizeJob(input), now = new Date().toISOString();
    return this.transaction(() => {
      const old = this.db.prepare('SELECT data FROM jobs WHERE batch_id=? AND platform=? AND job_id=?').get(batchId, job.platform, job.platformJobId);
      const previous = old ? JSON.parse(old.data) : null;
      // Revisiting a list must never erase an already captured detail.
      const merged = kind === 'list' && previous ? sanitizeJob({ ...previous, ...Object.fromEntries(Object.entries(job).filter(([k,v]) => v !== null && v !== '' && !['description','detailStatus','detailSource','employmentType','employmentEvidence'].includes(k))),
        dateEvidence:[...(previous.dateEvidence || []),...job.dateEvidence] }) : job;
      this.db.prepare(`INSERT INTO jobs(batch_id,platform,job_id,data,collected_at,detail_attempts) VALUES(?,?,?,?,?,?)
        ON CONFLICT(batch_id,platform,job_id) DO UPDATE SET data=excluded.data,collected_at=excluded.collected_at,detail_attempts=jobs.detail_attempts+excluded.detail_attempts`)
        .run(batchId, job.platform, job.platformJobId, JSON.stringify(merged), now, attempted ? 1 : 0);
      this.db.prepare('INSERT INTO snapshots(batch_id,job_id,kind,content_hash,data,captured_at) VALUES(?,?,?,?,?,?)').run(batchId, job.platformJobId, kind, hash(job), JSON.stringify(job), now);
      if (keyword !== null) this.db.prepare('INSERT OR IGNORE INTO origins VALUES(?,?,?)').run(batchId, job.platformJobId, keyword);
    });
  }
  jobs(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE batch_id=? ORDER BY rowid').all(id).map(row => ({ ...JSON.parse(row.data),
      collectedAt: row.collected_at, detailAttempts: row.detail_attempts,
      firstSeenAt:this.db.prepare('SELECT min(captured_at) AS first_seen FROM snapshots WHERE job_id=?').get(row.job_id).first_seen,
      keywords: this.db.prepare('SELECT keyword FROM origins WHERE batch_id=? AND job_id=? ORDER BY keyword').all(id, row.job_id).map(x => x.keyword) }));
  }
  saveRun(batchId, config) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(id, batchId, JSON.stringify(config), new Date().toISOString());
    return id;
  }
}
