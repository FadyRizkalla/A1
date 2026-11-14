# Concordia Events Board

A small web app where Concordia students post and find study sessions, exam prep, club meetups and other events —
e.g. *"COMP 348 exam prep · H building, 5th floor, room H-529 · Fri 5–7 PM"*.

**Stack:** Node.js + Express, SQLite (better-sqlite3), plain HTML/CSS/JS frontend. No build step.

## Features
- **Accounts** — sign up / log in with email + password (scrypt-hashed, HttpOnly cookie sessions); verify access to a Concordia email. Accounts can use the app before verification.
- **Student profiles** — add your program, year of study and courses this semester. Profiles are visible to signed-in users; email addresses stay private.
- **Clubs** — anyone can create a club and becomes its owner; the owner can add other admins by email. Admins edit the club page and post events *as the club*.
- **Follow clubs** — the **Following** tab shows upcoming events only from clubs you follow.
- **RSVP** — "I'm going" is per user (respects capacity); the **I'm going** tab lists your RSVPs.
- Post events with course code (auto-formatted: `comp348` → `COMP 348`), category, building (all SGW + Loyola buildings, plus Online), floor, room, time, description, contact, capacity
- Browse upcoming events grouped by day, **LIVE** badge, filters (search, course, campus, building, category, today / next 7 days)
- **Add to calendar** (.ics), shareable event links (`/#/e/<id>`), profile page with your clubs, follows and posts
- Rate limiting, input validation, CSRF guard, auto-pruning of old events; mobile-friendly with dark mode

## Run locally
```bash
npm install
npm start            # http://localhost:3000
npm run seed         # (optional, in another terminal) adds demo users, clubs and events
```
Demo logins after seeding (password `password123`): `fady@live.concordia.ca` (owns CS Society) and `sara@live.concordia.ca` (owns Math Help Club).
In local development, signup and demo-seed verification links are printed in the server terminal.

Upgrading from v1? Just start the new server — it migrates the existing database automatically (old posts are kept, with no owner).

`npm run dev` restarts on file changes.

## Configuration (env vars)
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/events.db` | SQLite file location |
| `VERIFIED_EMAIL_DOMAINS` | `live.concordia.ca,concordia.ca` | Concordia email domains accepted for account verification |
| `ALLOWED_EMAIL_DOMAINS` | – | Optional additional domain restriction, e.g. `live.concordia.ca` |
| `ADMIN_EMAILS` | – | Comma-separated site moderators who can delete any event / manage any club |
| `NODE_ENV` | – | Set to `production` when deployed behind HTTPS (marks the session cookie `Secure`) |
| `RESEND_API_KEY` | – | Resend API key used to send verification emails in production |
| `EMAIL_FROM` | – | Verified sender address, e.g. `Concordia Events <events@example.com>` |
| `APP_URL` | `http://localhost:3000` | Public base URL used to build email verification links |

In local development, verification links are printed in the server terminal. In production, configure `RESEND_API_KEY`, `EMAIL_FROM` and `APP_URL` and verify the sender domain in Resend. Email verification proves access to a Concordia email address; it does **not** verify current student enrollment.

## Deploy
SQLite needs a persistent disk, so use a host with volumes:
- **Render**: New Web Service → build `npm install`, start `npm start`, add a Disk mounted at `/data`, set `DB_PATH=/data/events.db`.
- **Railway / Fly.io**: use the included `Dockerfile`, attach a volume at `/data`.

(Vercel/Netlify serverless won't keep the SQLite file — you'd need to swap in Postgres.)

## API
All non-GET requests need the header `X-Requested-With: fetch` (CSRF guard). Auth is via the `sid` cookie.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | `{ email, password, name? }` |
| POST | `/api/auth/verify` | `{ token }` from the email verification link |
| POST | `/api/auth/resend-verification` | `{ email }` |
| GET | `/api/me` | user, clubs you manage, clubs you follow |
| PATCH | `/api/me/profile` | `{ program, study_year, courses }` |
| GET | `/api/users/:id` | Signed-in users can view another student's profile; email is never returned |
| GET | `/api/clubs` | `q, type` |
| POST | `/api/clubs` | create (you become owner) |
| GET / PATCH | `/api/clubs/:slug` | view / edit (admins) |
| POST / DELETE | `/api/clubs/:slug/follow` | follow / unfollow |
| POST | `/api/clubs/:slug/admins` | `{ email }` (owner) |
| DELETE | `/api/clubs/:slug/admins/:userId` | remove admin (owner) or leave |
| GET | `/api/events` | `feed` = following / going / mine, `club, q, course, category, campus, building, before, includePast=1` |
| POST | `/api/events` | create; pass `club_id` to post as a club you admin |
| GET / DELETE | `/api/events/:id` | delete = poster, club admin or site admin |
| POST / DELETE | `/api/events/:id/rsvp` | RSVP / un-RSVP |
| GET | `/api/events/:id/ics` | calendar file |

## Ideas for next steps
- Student-status verification through an official Concordia integration, if available
- Password reset (needs an email provider)
- Notifications when a followed club posts (email digest or web push)
- Report button + moderation queue
- Edit events, comments/Q&A per event
- Map view of SGW/Loyola buildings

---
Student-made project, not affiliated with Concordia University.
