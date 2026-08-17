'use strict';
/* Aufgaben – Server: node:http + node:sqlite, null Abhängigkeiten.
   Start:  node app.js       →  http://localhost:5173                     */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 5173;
const DIR = __dirname;

/* ---------------------------------------------------------------- DB --- */

const db = new DatabaseSync(path.join(DIR, 'tasks.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;
  CREATE TABLE IF NOT EXISTS tasks (
    id      INTEGER PRIMARY KEY,
    title   TEXT    NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    prio    INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    title   TEXT    NOT NULL DEFAULT '',
    body    TEXT    NOT NULL DEFAULT '',
    updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id      INTEGER PRIMARY KEY,
    mime    TEXT NOT NULL,
    bytes   BLOB NOT NULL,
    created INTEGER NOT NULL
  );
`);

const COLS = 'id, title, done, prio, created';
const S = {
  all:   db.prepare(`SELECT ${COLS} FROM tasks ORDER BY prio DESC, id DESC`),
  get:   db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`),
  add:   db.prepare('INSERT INTO tasks (title, done, prio, created) VALUES (?, ?, ?, ?)'),
  addId: db.prepare('INSERT INTO tasks (id, title, done, prio, created) VALUES (?, ?, ?, ?, ?)'),
  upd:   db.prepare('UPDATE tasks SET title = ?, done = ?, prio = ? WHERE id = ?'),
  del:   db.prepare('DELETE FROM tasks WHERE id = ?'),
  purge: db.prepare('DELETE FROM tasks WHERE done = 1'),
};

const N = {
  list: db.prepare('SELECT id, title, updated FROM notes ORDER BY updated DESC'),
  get:  db.prepare('SELECT id, title, body, updated FROM notes WHERE id = ?'),
  add:  db.prepare('INSERT INTO notes (title, body, updated) VALUES (?, ?, ?)'),
  upd:  db.prepare('UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?'),
  del:  db.prepare('DELETE FROM notes WHERE id = ?'),
  refs: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE body LIKE ?'),
};

const IMG = {
  add: db.prepare('INSERT INTO images (mime, bytes, created) VALUES (?, ?, ?)'),
  get: db.prepare('SELECT mime, bytes FROM images WHERE id = ?'),
  del: db.prepare('DELETE FROM images WHERE id = ?'),
};

/* ------------------------------------------------------------ Helfer --- */

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const prio = v => Math.min(2, Math.max(0, Number(v) || 0));

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 4_000_000) { req.destroy(); reject(new Error('Anfrage zu groß')); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

/** Rohe Bytes einlesen – für eingefügte Screenshots. */
function rawBody(req, limit = 16_000_000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('Bild zu groß (max. 16 MB)')); }
      else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- API --- */

async function api(req, res, url) {
  const m = req.method;

  if (url === '/api/tasks' && m === 'GET') return json(res, 200, S.all.all());

  if (url === '/api/tasks' && m === 'POST') {
    const b = await body(req);
    const title = String(b.title ?? '').trim();
    if (!title) return json(res, 400, { error: 'Titel fehlt' });
    const done = b.done ? 1 : 0;
    const created = Number(b.created) || Date.now();
    // id mitgeschickt = Wiederherstellen nach "Rückgängig"
    const id = b.id
      ? (S.addId.run(Number(b.id), title, done, prio(b.prio), created), Number(b.id))
      : Number(S.add.run(title, done, prio(b.prio), created).lastInsertRowid);
    return json(res, 201, S.get.get(id));
  }

  if (url === '/api/tasks/clear-done' && m === 'POST')
    return json(res, 200, { deleted: S.purge.run().changes });

  const hit = url.match(/^\/api\/tasks\/(\d+)$/);
  if (hit) {
    const id = Number(hit[1]);
    const cur = S.get.get(id);
    if (!cur) return json(res, 404, { error: 'Aufgabe nicht gefunden' });

    if (m === 'DELETE') { S.del.run(id); return json(res, 200, { ok: true }); }

    if (m === 'PATCH') {
      const b = await body(req);
      const title = b.title === undefined ? cur.title : String(b.title).trim();
      if (!title) return json(res, 400, { error: 'Titel darf nicht leer sein' });
      S.upd.run(
        title,
        b.done === undefined ? cur.done : (b.done ? 1 : 0),
        b.prio === undefined ? cur.prio : prio(b.prio),
        id,
      );
      return json(res, 200, S.get.get(id));
    }
  }

  /* ---- Notizen ---- */

  if (url === '/api/notes' && m === 'GET') return json(res, 200, N.list.all());

  if (url === '/api/notes' && m === 'POST') {
    const b = await body(req);
    const id = Number(N.add.run(String(b.title ?? ''), String(b.body ?? ''), Date.now()).lastInsertRowid);
    return json(res, 201, N.get.get(id));
  }

  const note = url.match(/^\/api\/notes\/(\d+)$/);
  if (note) {
    const id = Number(note[1]);
    const cur = N.get.get(id);
    if (!cur) return json(res, 404, { error: 'Notiz nicht gefunden' });

    if (m === 'GET') return json(res, 200, cur);

    if (m === 'DELETE') {
      N.del.run(id);
      sweepImages(cur.body);
      return json(res, 200, { ok: true });
    }

    if (m === 'PATCH') {
      const b = await body(req);
      N.upd.run(
        b.title === undefined ? cur.title : String(b.title),
        b.body === undefined ? cur.body : String(b.body),
        Date.now(),
        id,
      );
      if (b.body !== undefined) sweepImages(cur.body);   // gelöschte Bilder mitnehmen
      return json(res, 200, N.get.get(id));
    }
  }

  /* ---- Bilder (eingefügte Screenshots) ---- */

  if (url === '/api/img' && m === 'POST') {
    const mime = String(req.headers['content-type'] || '');
    if (!mime.startsWith('image/')) return json(res, 400, { error: 'Kein Bild' });
    const buf = await rawBody(req);
    if (!buf.length) return json(res, 400, { error: 'Leeres Bild' });
    const id = Number(IMG.add.run(mime, buf, Date.now()).lastInsertRowid);
    return json(res, 201, { id, url: `/api/img/${id}` });
  }

  const img = url.match(/^\/api\/img\/(\d+)$/);
  if (img && m === 'GET') {
    const row = IMG.get.get(Number(img[1]));
    if (!row) { res.writeHead(404).end('404'); return; }
    const buf = Buffer.from(row.bytes);
    res.writeHead(200, {
      'content-type': row.mime,
      'content-length': buf.length,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return res.end(buf);
  }

  json(res, 404, { error: 'Unbekannte Route' });
}

/** Bilder löschen, auf die keine Notiz mehr zeigt. */
function sweepImages(oldBody) {
  const ids = new Set([...String(oldBody).matchAll(/\/api\/img\/(\d+)"/g)].map(m => m[1]));
  for (const id of ids)
    if (N.refs.get(`%/api/img/${id}"%`).n === 0) IMG.del.run(Number(id));
}

/* ------------------------------------------------------------ Static --- */

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function statik(res, url) {
  const hit = FILES[url];
  if (!hit) { res.writeHead(404).end('404'); return; }
  fs.readFile(path.join(DIR, hit[0]), (err, buf) => {
    if (err) { res.writeHead(500).end('500'); return; }
    res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------ Server --- */

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/')) return statik(res, url);
  api(req, res, url).catch(e => json(res, 400, { error: String(e.message || e) }));
}).listen(PORT, () => console.log(`Aufgaben läuft:  http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => { db.close(); process.exit(0); });
