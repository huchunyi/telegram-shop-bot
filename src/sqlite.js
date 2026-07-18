'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function normalized(values) {
  return values.map((value) => value === undefined ? null : value);
}

class SqlStatement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
  }

  run(...values) {
    const stmt = this.owner.inner.prepare(this.sql);
    try {
      stmt.bind(normalized(values));
      stmt.step();
    } finally {
      stmt.free();
    }
    const info = this.owner.inner.exec('SELECT changes() AS changes, last_insert_rowid() AS last_id');
    const row = info[0]?.values?.[0] || [0, 0];
    this.owner.changed();
    return { changes: Number(row[0] || 0), lastInsertRowid: Number(row[1] || 0) };
  }

  get(...values) {
    const stmt = this.owner.inner.prepare(this.sql);
    try {
      stmt.bind(normalized(values));
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...values) {
    const stmt = this.owner.inner.prepare(this.sql);
    const rows = [];
    try {
      stmt.bind(normalized(values));
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class SqliteDatabase {
  constructor(SQL, filePath, bytes) {
    this.filePath = filePath;
    this.inner = bytes?.length ? new SQL.Database(bytes) : new SQL.Database();
    this.depth = 0;
    this.dirty = false;
  }

  pragma(value) {
    const source = String(value || '').trim();
    if (!source) return;
    this.inner.run(`PRAGMA ${source}`);
  }

  exec(sql) {
    this.inner.run(sql);
    this.changed();
  }

  prepare(sql) {
    return new SqlStatement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      if (this.depth > 0) return fn(...args);
      this.inner.run('BEGIN IMMEDIATE');
      this.depth += 1;
      try {
        const result = fn(...args);
        if (result && typeof result.then === 'function') throw new Error('SQLite 事务回调必须是同步函数');
        this.inner.run('COMMIT');
        this.depth -= 1;
        this.persist();
        return result;
      } catch (error) {
        try { this.inner.run('ROLLBACK'); } catch {}
        this.depth = Math.max(0, this.depth - 1);
        this.dirty = false;
        throw error;
      }
    };
  }

  changed() {
    this.dirty = true;
    if (this.depth === 0) this.persist();
  }

  persist() {
    if (!this.dirty) return;
    const bytes = this.inner.export();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(bytes));
    this.dirty = false;
  }

  close() {
    this.persist();
    this.inner.close();
  }
}

async function createSqliteDatabase(filePath) {
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  const bytes = fs.existsSync(filePath) ? new Uint8Array(fs.readFileSync(filePath)) : null;
  return new SqliteDatabase(SQL, filePath, bytes);
}

module.exports = { createSqliteDatabase, SqliteDatabase };
