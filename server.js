const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'autoservice.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'client');
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL, model TEXT NOT NULL, year INTEGER, plate TEXT);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
  price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  car_id INTEGER NOT NULL REFERENCES cars(id), service_id INTEGER NOT NULL REFERENCES services(id),
  comment TEXT, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const hash = (pw) => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const verify = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 32)); };

// Начальные данные: администратор и список услуг
if (!db.prepare('SELECT 1 FROM users WHERE role = ?').get('admin')) {
  db.prepare('INSERT INTO users (name,email,phone,password,role) VALUES (?,?,?,?,?)')
    .run('Администратор', 'admin@autoservice.local', '', hash('admin123'), 'admin');
}
if (!db.prepare('SELECT 1 FROM services').get()) {
  const ins = db.prepare('INSERT INTO services (name,description,price) VALUES (?,?,?)');
  [['Замена масла и фильтра', 'Масло, масляный фильтр, проверка уровней жидкостей', 1500],
   ['Диагностика ходовой', 'Осмотр подвески, рулевого управления и тормозов', 1200],
   ['Замена тормозных колодок', 'Комплект колодок на одну ось', 2400],
   ['Шиномонтаж', 'Снятие, монтаж и балансировка четырёх колёс', 2000],
   ['Компьютерная диагностика', 'Считывание ошибок и оценка состояния систем', 1000]]
    .forEach((s) => ins.run(...s));
}

const STATUSES = ['new', 'in_progress', 'done', 'cancelled'];
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function auth(req, _res, next) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  req.user = m && db.prepare('SELECT u.id,u.name,u.email,u.phone,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(m[1]);
  req.token = m && m[1];
  next();
}
const need = (req, res, next) => (req.user ? next() : bad(res, 'Войдите в аккаунт', 401));
const admin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : bad(res, 'Доступ только для администратора', 403));
app.use('/api', auth);

function startSession(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(token, userId);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

// --- Аутентификация ---
app.post('/api/register', (req, res) => {
  const name = str(req.body.name), email = str(req.body.email).toLowerCase(), phone = str(req.body.phone), pw = req.body.password;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Укажите имя и корректный email');
  if (typeof pw !== 'string' || pw.length < 6) return bad(res, 'Пароль — не короче 6 символов');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'Этот email уже зарегистрирован', 409);
  const id = db.prepare('INSERT INTO users (name,email,phone,password) VALUES (?,?,?,?)').run(name, email, phone, hash(pw)).lastInsertRowid;
  startSession(res, id);
  res.json(db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(id));
});
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(str(req.body.email).toLowerCase());
  if (!u || typeof req.body.password !== 'string' || !verify(req.body.password, u.password)) return bad(res, 'Неверный email или пароль', 401);
  startSession(res, u.id);
  res.json({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });
});
app.post('/api/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json(req.user || null));

// --- Услуги ---
app.get('/api/services', need, (req, res) => {
  const all = req.user.role === 'admin' && req.query.all === '1';
  res.json(db.prepare(`SELECT * FROM services ${all ? '' : 'WHERE active=1'} ORDER BY id`).all());
});
function serviceBody(b) {
  const name = str(b.name), price = Number(b.price);
  if (!name) return 'Укажите название услуги';
  if (!Number.isFinite(price) || price < 0) return 'Цена должна быть числом не меньше 0';
  return null;
}
app.post('/api/services', need, admin, (req, res) => {
  const err = serviceBody(req.body); if (err) return bad(res, err);
  const r = db.prepare('INSERT INTO services (name,description,price) VALUES (?,?,?)').run(str(req.body.name), str(req.body.description), Number(req.body.price));
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/services/:id', need, admin, (req, res) => {
  const err = serviceBody(req.body); if (err) return bad(res, err);
  const r = db.prepare('UPDATE services SET name=?,description=?,price=?,active=? WHERE id=?')
    .run(str(req.body.name), str(req.body.description), Number(req.body.price), req.body.active === false || req.body.active === 0 ? 0 : 1, req.params.id);
  if (!r.changes) return bad(res, 'Услуга не найдена', 404);
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id));
});
app.delete('/api/services/:id', need, admin, (req, res) => {
  const used = db.prepare('SELECT 1 FROM requests WHERE service_id=?').get(req.params.id);
  if (used) { // услуга есть в заявках — только скрываем
    db.prepare('UPDATE services SET active=0 WHERE id=?').run(req.params.id);
    return res.json({ ok: true, hidden: true });
  }
  db.prepare('DELETE FROM services WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- Автомобили ---
app.get('/api/cars', need, (req, res) => res.json(db.prepare('SELECT * FROM cars WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/cars', need, (req, res) => {
  const brand = str(req.body.brand), model = str(req.body.model), plate = str(req.body.plate).toUpperCase();
  const year = req.body.year ? Number(req.body.year) : null;
  if (!brand || !model) return bad(res, 'Укажите марку и модель');
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) return bad(res, 'Некорректный год выпуска');
  const r = db.prepare('INSERT INTO cars (user_id,brand,model,year,plate) VALUES (?,?,?,?,?)').run(req.user.id, brand, model, year, plate);
  res.json(db.prepare('SELECT * FROM cars WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/cars/:id', need, (req, res) => {
  const car = db.prepare('SELECT id FROM cars WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!car) return bad(res, 'Автомобиль не найден', 404);
  if (db.prepare('SELECT 1 FROM requests WHERE car_id=?').get(car.id)) return bad(res, 'Нельзя удалить автомобиль, по которому есть заявки', 409);
  db.prepare('DELETE FROM cars WHERE id=?').run(car.id);
  res.json({ ok: true });
});

// --- Заявки ---
const REQ_SQL = `SELECT r.id,r.status,r.comment,r.created_at,s.name AS service,s.price,
  c.brand||' '||c.model||COALESCE(' ('||NULLIF(c.plate,'')||')','') AS car,u.name AS client,u.phone,u.email
  FROM requests r JOIN services s ON s.id=r.service_id JOIN cars c ON c.id=r.car_id JOIN users u ON u.id=r.user_id`;
app.get('/api/requests', need, (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`${REQ_SQL} ORDER BY r.id DESC`).all()
    : db.prepare(`${REQ_SQL} WHERE r.user_id=? ORDER BY r.id DESC`).all(req.user.id);
  res.json(rows);
});
app.post('/api/requests', need, (req, res) => {
  const car = db.prepare('SELECT id FROM cars WHERE id=? AND user_id=?').get(req.body.car_id, req.user.id);
  const svc = db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(req.body.service_id);
  if (!car) return bad(res, 'Выберите свой автомобиль');
  if (!svc) return bad(res, 'Выберите доступную услугу');
  const r = db.prepare('INSERT INTO requests (user_id,car_id,service_id,comment) VALUES (?,?,?,?)').run(req.user.id, car.id, svc.id, str(req.body.comment));
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/requests/:id/status', need, (req, res) => {
  const status = req.body.status;
  if (!STATUSES.includes(status)) return bad(res, 'Неизвестный статус');
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if (!r) return bad(res, 'Заявка не найдена', 404);
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !(r.user_id === req.user.id && r.status === 'new' && status === 'cancelled')) return bad(res, 'Недостаточно прав', 403);
  db.prepare('UPDATE requests SET status=? WHERE id=?').run(status, r.id);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => bad(res, 'Не найдено', 404));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Автосервис: http://localhost:${PORT}`));
