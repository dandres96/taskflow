const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'taskflow-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DB_PATH = process.env.DB_PATH || 'taskflow.db';

// SMTP config (set via env vars)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'taskflow@noreply.com';

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
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#6366f1',
    created_by INTEGER,
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    complexity TEXT DEFAULT 'medium',
    project_id INTEGER,
    assignee_id INTEGER,
    created_by INTEGER,
    start_date TEXT,
    end_date TEXT,
    notified INTEGER DEFAULT 0,
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
  catch (e) { res.status(401).json({ error: 'Token invalido' }); }
}

// ── Email ───────────────────────────────────────────
let mailer = null;
if (SMTP_HOST) {
  mailer = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, auth: { user: SMTP_USER, pass: SMTP_PASS } });
}

async function sendDeadlineEmails() {
  if (!mailer) return;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const tasks = qall(`SELECT t.*, u.name as assignee_name, u.email as assignee_email, p.name as project_name
    FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.end_date = ? AND t.status != 'done' AND t.status != 'trash' AND t.notified = 0`, [tomorrowStr]);
  for (const t of tasks) {
    if (!t.assignee_email) continue;
    try {
      await mailer.sendMail({
        from: SMTP_FROM,
        to: t.assignee_email,
        subject: 'TaskFlow: Tarea vence manana - ' + t.title,
        text: 'Hola ' + t.assignee_name + ',\n\nLa tarea "' + t.title + '" vence manana (' + tomorrowStr + ').\nProyecto: ' + (t.project_name || 'Sin proyecto') + '\n\nEntra a TaskFlow para mas detalles.'
      });
      qrun('UPDATE tasks SET notified = 1 WHERE id = ?', [t.id]);
      console.log('Email sent to ' + t.assignee_email + ' for task #' + t.id);
    } catch (e) { console.log('Email error:', e.message); }
  }
}

// Check deadlines every hour
setInterval(sendDeadlineEmails, 3600000);

// ── Auth Routes ─────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = qget('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciales invalidas' });
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
  } catch (e) { res.status(400).json({ error: 'Email ya existe' }); }
});

app.post('/api/users/:id/remove', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  qrun('UPDATE users SET role = ? WHERE id = ?', ['trash', req.params.id]);
  res.json({ ok: true });
});

// ── Project Routes ──────────────────────────────────
app.get('/api/projects', auth, (req, res) => {
  res.json(qall('SELECT p.*, COUNT(t.id) as task_count FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.status != ? GROUP BY p.id ORDER BY p.created DESC', ['trash']));
});

app.post('/api/projects', auth, (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = qinsert('INSERT INTO projects (name, description, color, created_by) VALUES (?,?,?,?)', [name, description || '', color || '#6366f1', req.user.id]);
  res.json({ id, name, description, color: color || '#6366f1' });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const { name, description, color } = req.body;
  const proj = qget('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!proj) return res.status(404).json({ error: 'No encontrado' });
  qrun('UPDATE projects SET name=?, description=?, color=? WHERE id=?', [name || proj.name, description ?? proj.description, color || proj.color, req.params.id]);
  res.json({ id: parseInt(req.params.id), name, description, color });
});

app.post('/api/projects/:id/remove', auth, (req, res) => {
  qrun('UPDATE projects SET name = name || ? WHERE id = ?', [' [deleted]', req.params.id]);
  qrun('UPDATE tasks SET project_id = NULL WHERE project_id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── Task Routes ─────────────────────────────────────
app.get('/api/tasks', auth, (req, res) => {
  const { status, assignee, project } = req.query;
  let sql = `SELECT t.*, u.name as assignee_name, c.name as creator_name, p.name as project_name, p.color as project_color
    FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
    LEFT JOIN users c ON t.created_by = c.id
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status != 'trash'`;
  const params = [];
  if (status && status !== 'all') { sql += ' AND t.status = ?'; params.push(status); }
  if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id = ?'; params.push(assignee); }
  if (project && project !== 'all') { sql += ' AND t.project_id = ?'; params.push(project); }
  sql += ' ORDER BY t.updated DESC';
  res.json(qall(sql, params));
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, description, priority, complexity, assignee_id, project_id, start_date, end_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Titulo requerido' });
  const id = qinsert('INSERT INTO tasks (title, description, status, priority, complexity, project_id, assignee_id, created_by, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [title, description || '', 'todo', priority || 'medium', complexity || 'medium', project_id || null, assignee_id || null, req.user.id, start_date || null, end_date || null]);
  res.json(qget('SELECT t.*, u.name as assignee_name, p.name as project_name, p.color as project_color FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?', [id]));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const { title, description, status, priority, complexity, assignee_id, project_id, start_date, end_date } = req.body;
  const task = qget('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'No encontrada' });
  qrun('UPDATE tasks SET title=?, description=?, status=?, priority=?, complexity=?, project_id=?, assignee_id=?, start_date=?, end_date=?, updated=CURRENT_TIMESTAMP WHERE id=?',
    [title || task.title, description ?? task.description, status || task.status, priority || task.priority, complexity || task.complexity,
     project_id ?? task.project_id, assignee_id ?? task.assignee_id, start_date ?? task.start_date, end_date ?? task.end_date, req.params.id]);
  // Reset notified if end_date changes
  if (end_date && end_date !== task.end_date) qrun('UPDATE tasks SET notified = 0 WHERE id = ?', [req.params.id]);
  res.json(qget('SELECT t.*, u.name as assignee_name, p.name as project_name, p.color as project_color FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?', [req.params.id]));
});

app.post('/api/tasks/:id/remove', auth, (req, res) => {
  qrun('UPDATE tasks SET status = ? WHERE id = ?', ['trash', req.params.id]);
  res.json({ ok: true });
});

// ── Comment Routes ──────────────────────────────────
app.get('/api/tasks/:id/comments', auth, (req, res) => {
  res.json(qall('SELECT c.*, u.name as user_name FROM comments c JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created', [req.params.id]));
});

app.post('/api/tasks/:id/comments', auth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto requerido' });
  const id = qinsert('INSERT INTO comments (task_id, user_id, text) VALUES (?,?,?)', [req.params.id, req.user.id, text]);
  res.json(qget('SELECT c.*, u.name as user_name FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?', [id]));
});

// ── Start ───────────────────────────────────────────
async function start() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.exec(SCHEMA);
  saveDB();

  const count = qget('SELECT COUNT(*) as c FROM users', []);
  if (count.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    qrun('INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)', ['Admin', 'admin@taskflow.local', hash, 'admin']);
    console.log('Admin: admin@taskflow.local / admin123');
  }

  // Migrate: add columns if missing (for existing DBs)
  try { db.exec('ALTER TABLE tasks ADD COLUMN complexity TEXT DEFAULT "medium"'); } catch(e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN project_id INTEGER'); } catch(e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN start_date TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN end_date TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN notified INTEGER DEFAULT 0'); } catch(e) {}
  saveDB();

  app.listen(PORT, HOST, () => {
    console.log('TaskFlow v2 -> http://' + HOST + ':' + PORT);
    if (mailer) { console.log('SMTP: ' + SMTP_HOST); sendDeadlineEmails(); }
    else console.log('SMTP: not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
  });
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
