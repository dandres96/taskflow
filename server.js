const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
try { const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'); global.S3 = { S3Client, PutObjectCommand }; } catch(e) { global.S3 = null; console.log('AWS SDK not installed - R2 disabled'); }
try { const nodemailer = require('nodemailer'); global.nodemailer = nodemailer; } catch(e) { global.nodemailer = null; console.log('nodemailer not installed - emails disabled'); }

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'taskflow-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DB_PATH = process.env.DB_PATH || 'taskflow.db';

// Cloudflare R2 config
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || '';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'taskflow-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
let r2Client = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && global.S3) {
  r2Client = new global.S3.S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
  });
  console.log('R2 storage enabled:', R2_BUCKET);
} else {
  console.log('R2 storage disabled (missing env vars or aws-sdk)');
}

// SMTP config (set via env vars or Fly secrets)
// Recommended free provider: Brevo (ex-Sendinblue) — 300 emails/day free tier
// Sign up at https://www.brevo.com and create an SMTP key at
// https://app.brevo.com/settings/keys/smtp
// Then run: fly secrets set SMTP_HOST="smtp-relay.brevo.com" SMTP_PORT="587" \
//   SMTP_USER="your-brevo-login-email" SMTP_PASS="xsmtpsib-your-key" \
//   SMTP_FROM="taskflow@yourdomain.com" --app taskflow-cwti
const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'taskflow@noreply.com';

app.use(express.json({ limit: '10mb' }));
app.use(express.static('/data/public'));
// Serve app.html as index if it exists (hot-swap for updates)
app.get('/', (req, res) => {
  const p = require('path');
  const appFile = '/data/public/app.html';
  const indexFile = '/data/public/index.html';
  if (fs.existsSync(appFile)) res.sendFile(appFile);
  else res.sendFile(indexFile);
});

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
    image_path TEXT DEFAULT '',
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
    source TEXT DEFAULT 'manual',
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
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
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
if (nodemailer && SMTP_HOST) {
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

// ── Admin: SMTP test endpoint ──────────────────────
app.post('/api/admin/smtp/test', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  if (!mailer) return res.status(400).json({ error: 'SMTP no configurado (faltan SMTP_HOST/USER/PASS)' });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Falta campo "to"' });
  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to,
      subject: 'TaskFlow: prueba SMTP',
      text: 'Este es un email de prueba enviado desde TaskFlow.\n\nSi lo recibiste, el SMTP está configurado correctamente.\n\n— Equipo TaskFlow'
    });
    res.json({ ok: true, sent_to: to });
  } catch (e) {
    res.status(500).json({ error: 'Error SMTP: ' + e.message });
  }
});

// Admin: run deadline check now (don't wait for the hourly cron)
app.post('/api/admin/smtp/run-deadline-check', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  await sendDeadlineEmails();
  res.json({ ok: true });
});

// ── Public Routes (no auth) ───────────────────────
// Public project info by token
app.get('/api/public/project/:token', (req, res) => {
  const proj = qget('SELECT id, name, image_path FROM projects WHERE support_token = ?', [req.params.token]);
  if (!proj) return res.status(404).json({ error: 'Proyecto no encontrado' });
  res.json(proj);
});

// Public ticket submission
app.post('/api/public/tickets', async (req, res) => {
  const { project_token, reporter_name, description, image_data, video_data, video_filename } = req.body;
  if (!project_token || !reporter_name) return res.status(400).json({ error: 'Proyecto y nombre requeridos' });
  
  const proj = qget('SELECT id FROM projects WHERE support_token = ?', [project_token]);
  if (!proj) return res.status(404).json({ error: 'Proyecto inválido' });
  
  let imagePath = '';
  if (image_data && image_data.startsWith('data:')) {
    const ext = image_data.match(/^data:image\/(\w+);/)?.[1] || 'png';
    const base64 = image_data.split(',')[1];
    const filename = 'ticket_' + Date.now() + '.' + ext;
    try { fs.mkdirSync('/data/uploads', { recursive: true }); } catch(e) {}
    fs.writeFileSync('/data/uploads/' + filename, Buffer.from(base64, 'base64'));
    imagePath = '/uploads/' + filename;
  }
  
  let videoUrl = '';
  if (video_data && r2Client) {
    try {
      // video_data is a base64 data URL like "data:video/webm;base64,XXX"
      const match = video_data.match(/^data:([^;]+);base64,/);
      const mimeType = match ? match[1] : 'video/webm';
      const base64 = video_data.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      const ext = (video_filename && video_filename.split('.').pop()) || (mimeType.includes('mp4') ? 'mp4' : 'webm');
      const key = 'tickets/' + proj.id + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      await r2Client.send(new global.S3.PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType
      }));
      videoUrl = R2_PUBLIC_URL ? R2_PUBLIC_URL + '/' + key : `https://${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
    } catch(e) {
      console.error('R2 upload error:', e.message);
    }
  }
  
  const ticketId = qinsert('INSERT INTO support_tickets (project_id, reporter_name, description, image_path, video_url) VALUES (?,?,?,?,?)',
    [proj.id, reporter_name, description || '', imagePath, videoUrl]);
  
  // Auto-create a high-priority task linked to this ticket
  const firstLine = (description || '').split('\n')[0].slice(0, 80) || 'Reporte de soporte';
  const taskTitle = '[Soporte] ' + reporter_name + ': ' + firstLine;
  const taskDesc = 'Reportado por: ' + reporter_name + (description ? '\n\n' + description : '') + (imagePath ? '\n\nImagen: ' + imagePath : '') + (videoUrl ? '\n\nVideo: ' + videoUrl : '');
  const taskId = qinsert('INSERT INTO tasks (title, description, project_id, priority, status, source) VALUES (?,?,?,?,?,?)',
    [taskTitle, taskDesc, proj.id, 'high', 'todo', 'support_ticket:' + ticketId]);
  
  res.json({ ok: true, id: ticketId, task_id: taskId, video_uploaded: !!videoUrl });
});

// Serve public support page
app.get('/soporte', (req, res) => {
  res.sendFile('/data/public/soporte.html');
});
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

app.put('/api/me', auth, (req, res) => {
  const { name, current_password, new_password } = req.body;
  const user = qget('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'No encontrado' });
  
  // Validate current password
  if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Contrasena actual incorrecta' });
  }
  
  if (name) qrun('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  if (new_password && new_password.length >= 3) {
    const hash = bcrypt.hashSync(new_password, 10);
    qrun('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
  } else if (new_password && new_password.length < 3) {
    return res.status(400).json({ error: 'Contrasena muy corta (min 3)' });
  }
  
  const updated = qget('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true, user: updated });
});

app.get('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  res.json(qall('SELECT id, name, email, role FROM users WHERE role != ? ORDER BY name', ['trash']));
});

app.post('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
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
  const token = require('crypto').randomBytes(12).toString('hex');
  const id = qinsert('INSERT INTO projects (name, description, color, created_by, support_token) VALUES (?,?,?,?,?)', [name, description || '', color || '#6366f1', req.user.id, token]);
  res.json({ id, name, description, color: color || '#6366f1', support_token: token });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const { name, description, color, image_data } = req.body;
  const proj = qget('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!proj) return res.status(404).json({ error: 'No encontrado' });
  let imagePath = proj.image_path || '';
  if (image_data !== undefined) {
    if (image_data === null || image_data === '') {
      imagePath = '';
    } else if (image_data.startsWith('data:')) {
      const ext = image_data.match(/^data:image\/(\w+);/)?.[1] || 'png';
      const base64 = image_data.split(',')[1];
      const filename = 'project_' + req.params.id + '_' + Date.now() + '.' + ext;
      try { fs.mkdirSync('/data/uploads', { recursive: true }); } catch(e) {}
      fs.writeFileSync('/data/uploads/' + filename, Buffer.from(base64, 'base64'));
      imagePath = '/uploads/' + filename;
    }
  }
  qrun('UPDATE projects SET name=?, description=?, color=?, image_path=? WHERE id=?', [name || proj.name, description ?? proj.description, color || proj.color, imagePath, req.params.id]);
  const updated = qget('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  res.json(updated);
});

app.delete('/api/projects/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  // Delete related data first
  qrun('DELETE FROM support_tickets WHERE project_id = ?', [req.params.id]);
  qrun('DELETE FROM tasks WHERE project_id = ?', [req.params.id]);
  qrun('DELETE FROM projects WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Keep old endpoint for backward compat
app.post('/api/projects/:id/remove', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  qrun('DELETE FROM support_tickets WHERE project_id = ?', [req.params.id]);
  qrun('DELETE FROM tasks WHERE project_id = ?', [req.params.id]);
  qrun('DELETE FROM projects WHERE id = ?', [req.params.id]);
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
  // Devs only see tasks assigned to them
  if (req.user.role !== 'admin') { sql += ' AND (t.assignee_id = ? OR t.created_by = ?)'; params.push(req.user.id, req.user.id); }
  if (status && status !== 'all') { sql += ' AND t.status = ?'; params.push(status); }
  if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id = ?'; params.push(assignee); }
  if (project && project !== 'all') { sql += ' AND t.project_id = ?'; params.push(project); }
  sql += ' ORDER BY t.updated DESC';
  res.json(qall(sql, params));
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, description, priority, complexity, assignee_id, project_id, start_date, end_date } = req.body;
  // Devs can only assign tasks to themselves
  const finalAssignee = req.user.role !== 'admin' ? req.user.id : (assignee_id || null);
  if (!title) return res.status(400).json({ error: 'Titulo requerido' });
  const id = qinsert('INSERT INTO tasks (title, description, status, priority, complexity, project_id, assignee_id, created_by, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [title, description || '', 'todo', priority || 'medium', complexity || 'medium', project_id || null, finalAssignee, req.user.id, start_date || null, end_date || null]);
  res.json(qget('SELECT t.*, u.name as assignee_name, p.name as project_name, p.color as project_color FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?', [id]));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const { title, description, status, priority, complexity, assignee_id, project_id, start_date, end_date } = req.body;
  const task = qget('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'No encontrada' });
  const newStatus = status || task.status;
  const wasDone = task.status === 'done';
  const nowDone = newStatus === 'done';
  const completedAt = (!wasDone && nowDone) ? new Date().toISOString() : (nowDone ? (task.completed_at || null) : null);
  qrun('UPDATE tasks SET title=?, description=?, status=?, priority=?, complexity=?, project_id=?, assignee_id=?, start_date=?, end_date=?, completed_at=COALESCE(?,completed_at), updated=CURRENT_TIMESTAMP WHERE id=?',
    [title || task.title, description ?? task.description, newStatus, priority || task.priority, complexity || task.complexity,
     project_id ?? task.project_id, assignee_id ?? task.assignee_id, start_date ?? task.start_date, end_date ?? task.end_date, completedAt, req.params.id]);
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

// ── Dashboard Routes ───────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });

  // Total stats
  const totals = qget(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
    SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo
    FROM tasks WHERE status != 'trash'`);

  // Average completion time (in hours) - tasks completed in last 90 days
  const avgTime = qget(`SELECT
    ROUND(AVG((julianday(completed_at) - julianday(created)) * 24), 1) as avg_hours,
    MIN((julianday(completed_at) - julianday(created)) * 24) as min_hours,
    MAX((julianday(completed_at) - julianday(created)) * 24) as max_hours,
    COUNT(*) as completed_count
    FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at > datetime('now', '-90 days')`);

  // Completion rate by priority
  const byPriority = qall(`SELECT priority,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
    FROM tasks WHERE status != 'trash' GROUP BY priority`);

  // Completion rate by complexity
  const byComplexity = qall(`SELECT complexity,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
    FROM tasks WHERE status != 'trash' GROUP BY complexity`);

  // Tasks per project
  const byProject = qall(`SELECT p.id, p.name, p.color,
    COUNT(t.id) as total,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done,
    SUM(CASE WHEN t.status = 'in-progress' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) as todo
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.status != 'trash'
    GROUP BY p.id ORDER BY total DESC`);

  // Per user performance (last 30 days)
  const byUser = qall(`SELECT u.id, u.name,
    COUNT(t.id) as assigned,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN t.status = 'in-progress' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) as todo,
    ROUND(AVG(CASE WHEN t.completed_at IS NOT NULL THEN (julianday(t.completed_at) - julianday(t.created)) * 24 END), 1) as avg_hours,
    COUNT(CASE WHEN t.end_date < date('now') AND t.status != 'done' AND t.status != 'trash' THEN 1 END) as overdue
    FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status != 'trash'
    WHERE u.role != 'trash'
    GROUP BY u.id ORDER BY completed DESC`);

  // Completion trend (last 30 days, by day)
  const trend = qall(`SELECT date(completed_at) as day, COUNT(*) as count
    FROM tasks WHERE status = 'done' AND completed_at > datetime('now', '-30 days')
    GROUP BY date(completed_at) ORDER BY day`);

  // Tasks created vs completed (last 14 days)
  const velocity = qall(`SELECT
    date(d) as day,
    (SELECT COUNT(*) FROM tasks WHERE date(created) = date(d) AND status != 'trash') as created,
    (SELECT COUNT(*) FROM tasks WHERE date(completed_at) = date(d) AND status = 'done') as completed
    FROM (SELECT date('now', '-' || (14 - n) || ' days') as d FROM (SELECT 0 as n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13 UNION SELECT 14)) days
    ORDER BY day`);

  // Overdue tasks
  const overdue = qall(`SELECT t.*, u.name as assignee_name, p.name as project_name
    FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.end_date < date('now') AND t.status NOT IN ('done','trash') ORDER BY t.end_date`);

  res.json({
    totals,
    avgTime,
    byPriority,
    byComplexity,
    byProject,
    byUser,
    trend,
    velocity,
    overdue
  });
});

// ── Support Tickets ───────────────────────────────
// List tickets for a project
app.get('/api/projects/:id/tickets', auth, (req, res) => {
  res.json(qall('SELECT * FROM support_tickets WHERE project_id = ? ORDER BY created DESC', [req.params.id]));
});

// Create ticket (with optional image upload via base64)
app.post('/api/projects/:id/tickets', auth, (req, res) => {
  const { reporter_name, description, image_data, image_type } = req.body;
  if (!reporter_name) return res.status(400).json({ error: 'Nombre del reportante requerido' });
  
  let imagePath = '';
  if (image_data && image_data.startsWith('data:')) {
    const ext = image_data.match(/^data:image\/(\w+);/)?.[1] || 'png';
    const base64 = image_data.split(',')[1];
    const filename = 'ticket_' + Date.now() + '.' + ext;
    fs.writeFileSync('/data/uploads/' + filename, Buffer.from(base64, 'base64'));
    imagePath = '/uploads/' + filename;
  }
  
  const id = qinsert('INSERT INTO support_tickets (project_id, reporter_name, description, image_path) VALUES (?,?,?,?)',
    [req.params.id, reporter_name, description || '', imagePath]);
  res.json(qget('SELECT * FROM support_tickets WHERE id = ?', [id]));
});

// Change ticket status
app.put('/api/tickets/:id', auth, (req, res) => {
  const { status } = req.body;
  qrun('UPDATE support_tickets SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true });
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
  try { db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE projects ADD COLUMN support_token TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT "manual"'); } catch(e) {}
  try { db.exec('ALTER TABLE projects ADD COLUMN image_path TEXT DEFAULT ""'); } catch(e) {}
  try { db.exec('ALTER TABLE support_tickets ADD COLUMN video_url TEXT DEFAULT ""'); } catch(e) {}
  // Generate token for existing projects
  qall('SELECT id FROM projects WHERE support_token IS NULL').forEach(p => {
    qrun('UPDATE projects SET support_token = ? WHERE id = ?', [require('crypto').randomBytes(12).toString('hex'), p.id]);
  });
  saveDB();
  
  // Ensure uploads dir exists on persistent volume
  try { fs.mkdirSync('/data/uploads', { recursive: true }); } catch(e) {}
  app.use('/uploads', express.static('/data/uploads'));

  app.listen(PORT, HOST, () => {
    console.log('TaskFlow v2 -> http://' + HOST + ':' + PORT);
    if (mailer) { console.log('SMTP: ' + SMTP_HOST); sendDeadlineEmails(); }
    else console.log('SMTP: not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
  });
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
