// Concordia Events Board — Express + SQLite backend
// Users (cookie sessions), clubs with admins, follows, per-user RSVPs, events.
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "events.db");
const IS_PROD = process.env.NODE_ENV === "production";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const VERIFIED_EMAIL_DOMAINS = (process.env.VERIFIED_EMAIL_DOMAINS || "live.concordia.ca,concordia.ca")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Optional extra restriction, e.g. "live.concordia.ca"
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Site moderators who can delete anything, e.g. "you@live.concordia.ca"
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = 30;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---------- Reference data ----------
const CATEGORIES = ["Study session", "Exam prep", "Club", "Social", "Workshop", "Sports", "Other"];
const CLUB_TYPES = ["Academic", "Tech", "Cultural", "Arts", "Sports", "Social", "Volunteering", "Other"];

const BUILDINGS = [
  { code: "H", name: "Henry F. Hall Building", campus: "SGW" },
  { code: "EV", name: "Engineering, Computer Science & Visual Arts", campus: "SGW" },
  { code: "LB", name: "Webster Library / J.W. McConnell", campus: "SGW" },
  { code: "MB", name: "John Molson Building", campus: "SGW" },
  { code: "GM", name: "Guy-De Maisonneuve Building", campus: "SGW" },
  { code: "FG", name: "Faubourg Building", campus: "SGW" },
  { code: "FB", name: "Faubourg Ste-Catherine Building", campus: "SGW" },
  { code: "GN", name: "Grey Nuns Building", campus: "SGW" },
  { code: "LS", name: "Learning Square", campus: "SGW" },
  { code: "VA", name: "Visual Arts Building", campus: "SGW" },
  { code: "CL", name: "CL Annex", campus: "SGW" },
  { code: "ER", name: "ER Building", campus: "SGW" },
  { code: "CC", name: "Central Building", campus: "Loyola" },
  { code: "SP", name: "Richard J. Renaud Science Complex", campus: "Loyola" },
  { code: "VL", name: "Vanier Library", campus: "Loyola" },
  { code: "AD", name: "Administration Building", campus: "Loyola" },
  { code: "CJ", name: "Communication Studies & Journalism", campus: "Loyola" },
  { code: "HU", name: "Applied Science Hub", campus: "Loyola" },
  { code: "PC", name: "PERFORM Centre", campus: "Loyola" },
  { code: "RF", name: "Loyola Jesuit Hall", campus: "Loyola" },
  { code: "ONLINE", name: "Online (Zoom / Discord / Teams)", campus: "Online" },
  { code: "OTHER", name: "Other / off-campus", campus: "Other" },
];
const BUILDING_BY_CODE = Object.fromEntries(BUILDINGS.map((b) => [b.code, b]));

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified_at TEXT,
    program       TEXT NOT NULL DEFAULT '',
    study_year    TEXT NOT NULL DEFAULT '',
    courses       TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clubs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'Other',
    description TEXT,
    links       TEXT,
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS club_admins (
    club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL DEFAULT 'admin', -- 'owner' | 'admin'
    PRIMARY KEY (club_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS follows (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, club_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    course        TEXT,
    category      TEXT NOT NULL,
    building      TEXT NOT NULL,
    floor         TEXT,
    room          TEXT,
    location_note TEXT,
    starts_at     TEXT NOT NULL,
    ends_at       TEXT NOT NULL,
    description   TEXT,
    organizer     TEXT NOT NULL,
    contact       TEXT,
    capacity      INTEGER,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    club_id       INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rsvps (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, event_id)
  );
`);

{
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("email_verified_at")) db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  if (!cols.includes("program")) db.exec("ALTER TABLE users ADD COLUMN program TEXT NOT NULL DEFAULT ''");
  if (!cols.includes("study_year")) db.exec("ALTER TABLE users ADD COLUMN study_year TEXT NOT NULL DEFAULT ''");
  if (!cols.includes("courses")) db.exec("ALTER TABLE users ADD COLUMN courses TEXT NOT NULL DEFAULT ''");
}

// Migrate databases created by v1 (anonymous posts with delete tokens)
{
  const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  if (!cols.includes("user_id")) db.exec("ALTER TABLE events ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  if (!cols.includes("club_id")) db.exec("ALTER TABLE events ADD COLUMN club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE");
  if (cols.includes("token_hash")) db.exec("ALTER TABLE events DROP COLUMN token_hash");
  if (cols.includes("going")) db.exec("ALTER TABLE events DROP COLUMN going");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
  CREATE INDEX IF NOT EXISTS idx_events_club ON events(club_id);
  CREATE INDEX IF NOT EXISTS idx_follows_club ON follows(club_id);
  CREATE INDEX IF NOT EXISTS idx_rsvps_event ON rsvps(event_id);
`);

// ---------- Helpers ----------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split("$");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

function clean(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
}
function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function normalizeCourse(v) {
  const s = clean(v, 20);
  if (!s) return null;
  const m = s.toUpperCase().match(/^([A-Z]{3,4})[\s-]*(\d{3}[A-Z]?)$/);
  return m ? `${m[1]} ${m[2]}` : s.toUpperCase();
}
function slugify(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "club";
}
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const publicUser = (u) => (u ? {
  id: u.id, name: u.name, email: u.email, email_verified: !!u.email_verified_at,
  program: u.program || "", study_year: u.study_year || "", courses: u.courses || "",
  is_site_admin: ADMIN_EMAILS.includes(u.email.toLowerCase()),
} : null);

async function sendVerificationEmail(email, token) {
  const verificationUrl = new URL(`/#/verify/${token}`, APP_URL).href;
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    if (IS_PROD) throw new Error("RESEND_API_KEY and EMAIL_FROM must be configured to send verification email.");
    console.log(`Email verification link for ${email}: ${verificationUrl}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: "Verify your Concordia Events email",
      text: `Confirm that you can access this Concordia email address:\n\n${verificationUrl}\n\nThis link expires in 24 hours. Verifying your email does not confirm current student enrollment.`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}.`);
}

async function issueVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  await sendVerificationEmail(user.email, token);
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at
  `).run(user.id, sha256(token), new Date(Date.now() + 24 * 3600e3).toISOString());
}

// ---------- Rate limiter ----------
const hits = new Map();
function rateLimit(max, windowMs, name) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Slow down — too many requests. Try again later." });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// ---------- Sessions ----------
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)").run(sha256(token), userId, expires.toISOString());
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: IS_PROD, expires, path: "/" });
}
function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie).sid;
  req.user = null;
  if (token) {
    req.user = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), nowIso()) || null;
  }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please log in first." });
  next();
}
// CSRF guard: state-changing requests must come from our own JS (custom header can't be sent cross-site without CORS)
function csrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Requested-With") !== "fetch") return res.status(403).json({ error: "Bad request origin." });
  next();
}

const isSiteAdmin = (user) => !!user && ADMIN_EMAILS.includes(user.email.toLowerCase());
const clubRole = (clubId, userId) =>
  userId ? db.prepare("SELECT role FROM club_admins WHERE club_id = ? AND user_id = ?").get(clubId, userId)?.role || null : null;

// ---------- Event serialization ----------
const EVENT_SELECT = `
  SELECT e.*, c.slug AS club_slug, c.name AS club_name,
         (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS going,
         EXISTS(SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.user_id = @uid) AS is_going,
         (e.user_id = @uid
           OR EXISTS(SELECT 1 FROM club_admins a WHERE a.club_id = e.club_id AND a.user_id = @uid)) AS can_delete
  FROM events e LEFT JOIN clubs c ON c.id = e.club_id`;
function serializeEvent(row, user) {
  if (!row) return row;
  const b = BUILDING_BY_CODE[row.building];
  return {
    ...row,
    is_going: !!row.is_going,
    can_delete: !!row.can_delete || isSiteAdmin(user),
    club: row.club_id ? { id: row.club_id, slug: row.club_slug, name: row.club_name } : null,
    club_slug: undefined, club_name: undefined,
    building_name: b ? b.name : row.building,
    campus: b ? b.campus : "Other",
  };
}
const getEvent = (id, user) =>
  serializeEvent(db.prepare(`${EVENT_SELECT} WHERE e.id = @id`).get({ id, uid: user?.id ?? -1 }), user);

function validateEvent(body) {
  const errors = [];
  const ev = {
    title: clean(body.title, 120),
    course: normalizeCourse(body.course),
    category: clean(body.category, 30),
    building: clean(body.building, 10)?.toUpperCase() || null,
    floor: clean(body.floor, 20),
    room: clean(body.room, 20),
    location_note: clean(body.location_note, 120),
    description: cleanText(body.description, 2000),
    contact: clean(body.contact, 120),
    capacity: body.capacity ? parseInt(body.capacity, 10) : null,
  };
  if (!ev.title || ev.title.length < 3) errors.push("Title must be at least 3 characters.");
  if (!CATEGORIES.includes(ev.category)) errors.push("Pick a valid category.");
  if (!ev.building || !BUILDING_BY_CODE[ev.building]) errors.push("Pick a valid building.");
  if (ev.capacity !== null && (!Number.isFinite(ev.capacity) || ev.capacity < 1 || ev.capacity > 10000))
    errors.push("Capacity must be between 1 and 10000.");
  const start = new Date(body.starts_at);
  const end = body.ends_at ? new Date(body.ends_at) : new Date(start.getTime() + 2 * 3600e3);
  if (isNaN(start)) errors.push("Start time is invalid.");
  else {
    if (isNaN(end) || end <= start) errors.push("End time must be after start time.");
    else if (end < Date.now()) errors.push("Event can't be entirely in the past.");
    if (start > Date.now() + 365 * 86400e3) errors.push("Event must be within the next year.");
    if (end - start > 24 * 3600e3) errors.push("Events can last at most 24 hours.");
  }
  if (!errors.length) { ev.starts_at = start.toISOString(); ev.ends_at = end.toISOString(); }
  return { ev, errors };
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", loadUser, csrf);

app.get("/api/meta", (_req, res) =>
  res.json({
    categories: CATEGORIES, buildings: BUILDINGS, club_types: CLUB_TYPES,
    allowed_domains: ALLOWED_DOMAINS.length ? ALLOWED_DOMAINS : VERIFIED_EMAIL_DOMAINS,
  }));

// ----- Auth -----
app.post("/api/auth/signup", rateLimit(10, 3600e3, "signup"), async (req, res) => {
  const email = clean(req.body?.email, 120)?.toLowerCase();
  const name = clean(req.body?.name, 60);
  const password = String(req.body?.password || "");
  const errors = [];
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("Enter a valid email.");
  else if (!VERIFIED_EMAIL_DOMAINS.includes(email.split("@")[1]))
    errors.push(`Use a Concordia email (${VERIFIED_EMAIL_DOMAINS.map((d) => "@" + d).join(" or ")}).`);
  else if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(email.split("@")[1]))
    errors.push(`Use your ${ALLOWED_DOMAINS.map((d) => "@" + d).join(" or ")} email.`);
  if (!name || name.length < 2) errors.push("Enter your name.");
  if (password.length < 8) errors.push("Password must be at least 8 characters.");
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email))
    return res.status(409).json({ error: "An account with that email already exists. Log in instead." });
  const info = db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)")
    .run(email, name, hashPassword(password), nowIso());
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  try {
    await issueVerificationEmail(user);
  } catch (err) {
    console.error("Failed to send signup verification email:", err.message);
    return res.status(503).json({ error: "Your account was created, but the verification email could not be sent. Log in and try sending it again." });
  }
  createSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

app.post("/api/auth/login", rateLimit(20, 15 * 60e3, "login"), (req, res) => {
  const email = clean(req.body?.email, 120)?.toLowerCase() || "";
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(String(req.body?.password || ""), user.password_hash))
    return res.status(401).json({ error: "Wrong email or password." });
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/verify", (req, res) => {
  const token = clean(req.body?.token, 100);
  if (!token) return res.status(400).json({ error: "Verification link is invalid or has expired." });
  const record = db.prepare(`
    SELECT user_id FROM email_verification_tokens WHERE token_hash = ? AND expires_at > ?
  `).get(sha256(token), nowIso());
  if (!record) return res.status(400).json({ error: "Verification link is invalid or has expired. Request a new one from your profile." });
  db.transaction(() => {
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(nowIso(), record.user_id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(record.user_id);
  })();
  res.json({ ok: true });
});

app.post("/api/auth/resend-verification", rateLimit(3, 3600e3, "resend-verification"), async (req, res) => {
  const email = clean(req.body?.email, 120)?.toLowerCase();
  const generic = { message: "If an unverified account exists for that Concordia email, a new verification link has been sent or generated." };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !VERIFIED_EMAIL_DOMAINS.includes(email.split("@")[1]))
    return res.json(generic);
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND email_verified_at IS NULL").get(email);
  if (!user) return res.json(generic);
  try {
    await issueVerificationEmail(user);
    res.json(generic);
  } catch (err) {
    console.error("Failed to resend verification email:", err.message);
    res.status(503).json({ error: "The verification email could not be sent. Please try again later." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  const uid = req.user.id;
  res.json({
    user: publicUser(req.user),
    managed_clubs: db.prepare(`
      SELECT c.id, c.slug, c.name, a.role FROM club_admins a JOIN clubs c ON c.id = a.club_id
      WHERE a.user_id = ? ORDER BY c.name`).all(uid),
    following: db.prepare(`
      SELECT c.id, c.slug, c.name, c.type FROM follows f JOIN clubs c ON c.id = f.club_id
      WHERE f.user_id = ? ORDER BY c.name`).all(uid),
  });
});

app.patch("/api/me/profile", requireUser, (req, res) => {
  const program = clean(req.body?.program, 120) || "";
  const studyYear = clean(req.body?.study_year, 40) || "";
  const courses = cleanText(req.body?.courses, 500) || "";
  db.prepare("UPDATE users SET program = ?, study_year = ?, courses = ? WHERE id = ?")
    .run(program, studyYear, courses, req.user.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.get("/api/users/:id", requireUser, (req, res) => {
  const user = db.prepare(`
    SELECT id, name, program, study_year, courses, email_verified_at
    FROM users WHERE id = ?
  `).get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: "Student profile not found." });
  res.json({ ...user, email_verified: !!user.email_verified_at, email_verified_at: undefined });
});

// ----- Clubs -----
const CLUB_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM follows f WHERE f.club_id = c.id) AS followers,
    (SELECT COUNT(*) FROM events e WHERE e.club_id = c.id AND e.ends_at >= @now) AS upcoming,
    EXISTS(SELECT 1 FROM follows f WHERE f.club_id = c.id AND f.user_id = @uid) AS is_following,
    (SELECT role FROM club_admins a WHERE a.club_id = c.id AND a.user_id = @uid) AS my_role
  FROM clubs c`;
const serializeClub = (c) => c && { ...c, is_following: !!c.is_following };

app.get("/api/clubs", (req, res) => {
  const params = { now: nowIso(), uid: req.user?.id ?? -1 };
  const where = [];
  if (req.query.q) { where.push("(c.name LIKE @q OR c.description LIKE @q)"); params.q = `%${String(req.query.q).slice(0, 60)}%`; }
  if (req.query.type && CLUB_TYPES.includes(req.query.type)) { where.push("c.type = @type"); params.type = req.query.type; }
  const sql = `${CLUB_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY followers DESC, c.name LIMIT 300`;
  res.json(db.prepare(sql).all(params).map(serializeClub));
});

app.post("/api/clubs", requireUser, rateLimit(5, 24 * 3600e3, "club-create"), (req, res) => {
  const name = clean(req.body?.name, 80);
  const type = CLUB_TYPES.includes(req.body?.type) ? req.body.type : "Other";
  const description = cleanText(req.body?.description, 1500);
  const links = clean(req.body?.links, 200);
  if (!name || name.length < 3) return res.status(400).json({ error: "Club name must be at least 3 characters." });
  if (db.prepare("SELECT 1 FROM clubs WHERE name = ? COLLATE NOCASE").get(name))
    return res.status(409).json({ error: "A club with that name already exists." });
  let slug = slugify(name), n = 2;
  while (db.prepare("SELECT 1 FROM clubs WHERE slug = ?").get(slug)) slug = `${slugify(name)}-${n++}`;
  const create = db.transaction(() => {
    const info = db.prepare("INSERT INTO clubs (slug,name,type,description,links,owner_id,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(slug, name, type, description, links, req.user.id, nowIso());
    db.prepare("INSERT INTO club_admins (club_id,user_id,role) VALUES (?,?, 'owner')").run(info.lastInsertRowid, req.user.id);
    db.prepare("INSERT INTO follows (user_id,club_id,created_at) VALUES (?,?,?)").run(req.user.id, info.lastInsertRowid, nowIso());
  });
  create();
  res.status(201).json(serializeClub(db.prepare(`${CLUB_SELECT} WHERE c.slug = @slug`).get({ slug, now: nowIso(), uid: req.user.id })));
});

function findClub(req, res, next) {
  const club = db.prepare(`${CLUB_SELECT} WHERE c.slug = @slug`).get({ slug: req.params.slug, now: nowIso(), uid: req.user?.id ?? -1 });
  if (!club) return res.status(404).json({ error: "Club not found." });
  req.club = serializeClub(club);
  next();
}
const requireClubAdmin = (req, res, next) =>
  req.club.my_role || isSiteAdmin(req.user) ? next() : res.status(403).json({ error: "Only club admins can do that." });

app.get("/api/clubs/:slug", findClub, (req, res) => {
  const club = { ...req.club };
  if (club.my_role || isSiteAdmin(req.user)) {
    club.admins = db.prepare(`
      SELECT u.id, u.name, u.email, a.role FROM club_admins a JOIN users u ON u.id = a.user_id
      WHERE a.club_id = ? ORDER BY a.role DESC, u.name`).all(club.id);
  }
  res.json(club);
});

app.patch("/api/clubs/:slug", requireUser, findClub, requireClubAdmin, (req, res) => {
  const b = req.body || {};
  const updates = {
    description: b.description !== undefined ? cleanText(b.description, 1500) : req.club.description,
    links: b.links !== undefined ? clean(b.links, 200) : req.club.links,
    type: CLUB_TYPES.includes(b.type) ? b.type : req.club.type,
  };
  db.prepare("UPDATE clubs SET description = @description, links = @links, type = @type WHERE id = @id").run({ ...updates, id: req.club.id });
  res.json({ ok: true });
});

app.post("/api/clubs/:slug/follow", requireUser, findClub, (req, res) => {
  db.prepare("INSERT OR IGNORE INTO follows (user_id, club_id, created_at) VALUES (?,?,?)").run(req.user.id, req.club.id, nowIso());
  res.json({ following: true, followers: db.prepare("SELECT COUNT(*) n FROM follows WHERE club_id = ?").get(req.club.id).n });
});
app.delete("/api/clubs/:slug/follow", requireUser, findClub, (req, res) => {
  db.prepare("DELETE FROM follows WHERE user_id = ? AND club_id = ?").run(req.user.id, req.club.id);
  res.json({ following: false, followers: db.prepare("SELECT COUNT(*) n FROM follows WHERE club_id = ?").get(req.club.id).n });
});

// Owner adds/removes admins by email
app.post("/api/clubs/:slug/admins", requireUser, findClub, (req, res) => {
  if (req.club.my_role !== "owner" && !isSiteAdmin(req.user)) return res.status(403).json({ error: "Only the club owner can add admins." });
  const email = clean(req.body?.email, 120)?.toLowerCase() || "";
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!u) return res.status(404).json({ error: "No user with that email — they need to sign up first." });
  db.prepare("INSERT OR IGNORE INTO club_admins (club_id, user_id, role) VALUES (?,?, 'admin')").run(req.club.id, u.id);
  res.status(201).json({ ok: true });
});
app.delete("/api/clubs/:slug/admins/:userId", requireUser, findClub, (req, res) => {
  const target = Number(req.params.userId);
  const isSelf = target === req.user.id;
  if (req.club.my_role !== "owner" && !isSiteAdmin(req.user) && !isSelf) return res.status(403).json({ error: "Only the club owner can remove admins." });
  const row = db.prepare("SELECT role FROM club_admins WHERE club_id = ? AND user_id = ?").get(req.club.id, target);
  if (!row) return res.status(404).json({ error: "Not an admin." });
  if (row.role === "owner") return res.status(400).json({ error: "The owner can't be removed." });
  db.prepare("DELETE FROM club_admins WHERE club_id = ? AND user_id = ?").run(req.club.id, target);
  res.json({ ok: true });
});

// ----- Events -----
app.get("/api/events", (req, res) => {
  const uid = req.user?.id ?? -1;
  const where = [];
  const params = { uid };
  if (req.query.includePast !== "1") { where.push("e.ends_at >= @now"); params.now = nowIso(); }
  if (req.query.feed === "following") {
    if (!req.user) return res.status(401).json({ error: "Log in to see events from clubs you follow." });
    where.push("e.club_id IN (SELECT club_id FROM follows WHERE user_id = @uid)");
  }
  if (req.query.feed === "going") {
    if (!req.user) return res.status(401).json({ error: "Log in to see events you're going to." });
    where.push("EXISTS(SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.user_id = @uid)");
  }
  if (req.query.feed === "mine") {
    if (!req.user) return res.status(401).json({ error: "Log in first." });
    where.push("e.user_id = @uid");
  }
  if (req.query.club) { where.push("c.slug = @club"); params.club = String(req.query.club); }
  if (req.query.category && CATEGORIES.includes(req.query.category)) { where.push("e.category = @category"); params.category = req.query.category; }
  if (req.query.building) { where.push("e.building = @building"); params.building = String(req.query.building).toUpperCase(); }
  if (req.query.campus) {
    const codes = BUILDINGS.filter((b) => b.campus === req.query.campus).map((b) => `'${b.code}'`);
    if (codes.length) where.push(`e.building IN (${codes.join(",")})`);
  }
  if (req.query.course) {
    where.push("REPLACE(e.course,' ','') LIKE @course");
    params.course = `%${String(req.query.course).toUpperCase().replace(/\s+/g, "")}%`;
  }
  if (req.query.q) {
    where.push("(e.title LIKE @q OR e.description LIKE @q OR e.course LIKE @q OR e.organizer LIKE @q OR e.room LIKE @q OR c.name LIKE @q)");
    params.q = `%${String(req.query.q).slice(0, 60)}%`;
  }
  if (req.query.before) {
    const d = new Date(req.query.before);
    if (!isNaN(d)) { where.push("e.starts_at < @before"); params.before = d.toISOString(); }
  }
  const sql = `${EVENT_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.starts_at ASC LIMIT 300`;
  res.json(db.prepare(sql).all(params).map((r) => serializeEvent(r, req.user)));
});

app.get("/api/events/:id", (req, res) => {
  const e = getEvent(req.params.id, req.user);
  if (!e) return res.status(404).json({ error: "Event not found." });
  res.json(e);
});

app.post("/api/events", requireUser, rateLimit(15, 3600e3, "event-create"), (req, res) => {
  const { ev, errors } = validateEvent(req.body || {});
  let club = null;
  if (req.body?.club_id) {
    club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(Number(req.body.club_id));
    if (!club) errors.push("Club not found.");
    else if (!clubRole(club.id, req.user.id) && !isSiteAdmin(req.user)) errors.push("You're not an admin of that club.");
  }
  if (errors.length) return res.status(400).json({ error: errors.join(" "), errors });
  const id = crypto.randomBytes(6).toString("base64url");
  db.prepare(`
    INSERT INTO events (id,title,course,category,building,floor,room,location_note,starts_at,ends_at,
                        description,organizer,contact,capacity,user_id,club_id,created_at)
    VALUES (@id,@title,@course,@category,@building,@floor,@room,@location_note,@starts_at,@ends_at,
            @description,@organizer,@contact,@capacity,@user_id,@club_id,@created_at)
  `).run({ ...ev, id, organizer: club ? club.name : req.user.name, user_id: req.user.id, club_id: club?.id ?? null, created_at: nowIso() });
  res.status(201).json(getEvent(id, req.user));
});

app.delete("/api/events/:id", requireUser, (req, res) => {
  const e = getEvent(req.params.id, req.user);
  if (!e) return res.status(404).json({ error: "Event not found." });
  if (!e.can_delete) return res.status(403).json({ error: "Only the poster or a club admin can delete this event." });
  db.prepare("DELETE FROM events WHERE id = ?").run(e.id);
  res.json({ ok: true });
});

app.post("/api/events/:id/rsvp", requireUser, (req, res) => {
  const e = getEvent(req.params.id, req.user);
  if (!e) return res.status(404).json({ error: "Event not found." });
  if (!e.is_going && e.capacity && e.going >= e.capacity) return res.status(409).json({ error: "This event is full." });
  db.prepare("INSERT OR IGNORE INTO rsvps (user_id, event_id, created_at) VALUES (?,?,?)").run(req.user.id, e.id, nowIso());
  res.json(getEvent(e.id, req.user));
});
app.delete("/api/events/:id/rsvp", requireUser, (req, res) => {
  db.prepare("DELETE FROM rsvps WHERE user_id = ? AND event_id = ?").run(req.user.id, req.params.id);
  const e = getEvent(req.params.id, req.user);
  if (!e) return res.status(404).json({ error: "Event not found." });
  res.json(e);
});

// Calendar file (.ics)
app.get("/api/events/:id/ics", (req, res) => {
  const e = getEvent(req.params.id, null);
  if (!e) return res.status(404).send("Not found");
  const fmt = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (m) => "\\" + m);
  const loc = [e.building_name, e.floor && `floor ${e.floor}`, e.room && `room ${e.room}`, e.location_note].filter(Boolean).join(", ");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Concordia Events Board//EN", "BEGIN:VEVENT",
    `UID:${e.id}@concordia-events-board`, `DTSTAMP:${fmt(nowIso())}`,
    `DTSTART:${fmt(e.starts_at)}`, `DTEND:${fmt(e.ends_at)}`,
    `SUMMARY:${esc((e.course ? e.course + " — " : "") + e.title)}`,
    `LOCATION:${esc(loc)}`, `DESCRIPTION:${esc((e.club ? `By ${e.club.name}\n` : "") + (e.description || ""))}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="event-${e.id}.ics"`);
  res.send(ics);
});

// Housekeeping: prune old events, sessions, and verification tokens hourly
setInterval(() => {
  db.prepare("DELETE FROM events WHERE ends_at < ?").run(new Date(Date.now() - 30 * 86400e3).toISOString());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  db.prepare("DELETE FROM email_verification_tokens WHERE expires_at < ?").run(nowIso());
}, 3600e3).unref();

if (require.main === module) {
  app.listen(PORT, () => console.log(`Concordia Events Board running on http://localhost:${PORT}`));
}
module.exports = app;
