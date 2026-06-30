const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const localtunnel = require('localtunnel');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'taskflow-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || 'taskflow.db';

app.use(express.json());
app.use(express.static('public'));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'dev',
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    assignee_id INTEGER,
    created_by INTEGER,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// ── DB helpers ──────────────────────────────────────
let db;
function saveDB() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

function qrun(sql, params = []) { db.run(sql, params); saveDB(); }
function qget(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free(); return row;
}
function qall(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = []; while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function qinsert(sql, params = []) {
  db.run(sql, params);
  const r = qget('SELECT last_insert_rowid() as id');
  saveDB();
  return r.id;
}

// ── Auth ────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Token inválido' }); }
}

// ── Routes ──────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = qget('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciales inválidas' });
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/me', auth, (req, res) => {
  res.json(qget('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id]));
});

app.get('/api/users', auth, (req, res) => {
  res.json(qall('SELECT id, name, email, role FROM users WHERE role != ? ORDER BY name', ['trash']));
});

app.post('/api/users', auth, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Faltan campos' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = qinsert('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', [name, email, hash, role || 'dev']);
    res.json({ id, name, email, role: role || 'dev' });
  } catch (e) { res.status(400).json({ error: 'Email ya existe o datos inválidos' }); }
});

app.post('/api/users/:id/remove', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  qrun('UPDATE users SET role = ? WHERE id = ?', ['trash', req.params.id]);
  res.json({ ok: true });
});

app.get('/api/tasks', auth, (req, res) => {
  const { status, assignee } = req.query;
  let sql = `SELECT t.*, u.name as assignee_name, c.name as creator_name
    FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
    LEFT JOIN users c ON t.created_by = c.id
    WHERE t.status != 'trash'`;
  const params = [];
  if (status && status !== 'all') { sql += ' AND t.status = ?'; params.push(status); }
  if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id = ?'; params.push(assignee); }
  sql += ' ORDER BY t.updated DESC';
  res.json(qall(sql, params));
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, description, priority, assignee_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Título requerido' });
  const id = qinsert('INSERT INTO tasks (title, description, status, priority, assignee_id, created_by) VALUES (?,?,?,?,?,?)',
    [title, description || '', 'todo', priority || 'medium', assignee_id || null, req.user.id]);
  res.json(qget('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?', [id]));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const { title, description, status, priority, assignee_id } = req.body;
  const task = qget('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'No encontrada' });
  qrun('UPDATE tasks SET title=?, description=?, status=?, priority=?, assignee_id=?, updated=CURRENT_TIMESTAMP WHERE id=?',
    [title || task.title, description ?? task.description, status || task.status, priority || task.priority, assignee_id ?? task.assignee_id, req.params.id]);
  res.json(qget('SELECT t.*, u.name as assignee_name FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?', [req.params.id]));
});

app.post('/api/tasks/:id/remove', auth, (req, res) => {
  qrun('UPDATE tasks SET status = ? WHERE id = ?', ['trash', req.params.id]);
  res.json({ ok: true });
});

app.get('/api/tasks/:id/comments', auth, (req, res) => {
  res.json(qall('SELECT c.*, u.name as user_name FROM comments c JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created', [req.params.id]));
});

app.post('/api/tasks/:id/comments', auth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto requerido' });
  const id = qinsert('INSERT INTO comments (task_id, user_id, text) VALUES (?,?,?)', [req.params.id, req.user.id, text]);
  res.json(qget('SELECT c.*, u.name as user_name FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?', [id]));
});

// ── Start ────────────────────────────────────────────
async function start() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.exec(SCHEMA);
  saveDB();

  // Seed admin
  const count = qget('SELECT COUNT(*) as c FROM users', []);
  if (count.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    qrun('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', ['Admin', 'admin@taskflow.local', hash, 'admin']);
    console.log('Admin: admin@taskflow.local / admin123');
  }

  app.listen(PORT, () => {
    console.log('TaskFlow → http://localhost:' + PORT);
    function connectTunnel() {
      localtunnel({ port: PORT }).then(t => {
        fs.writeFileSync('tunnel-url.txt', t.url);
        console.log('Public: ' + t.url);
        t.on('close', () => { console.log('Tunnel closed, reconnecting...'); setTimeout(connectTunnel, 3000); });
        t.on('error', () => { console.log('Tunnel error, reconnecting...'); setTimeout(connectTunnel, 3000); });
      }).catch(() => { console.log('Tunnel retry in 5s...'); setTimeout(connectTunnel, 5000); });
    }
    connectTunnel();
  });
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
