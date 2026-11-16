# PetXport

Plan volunteer pet transports leg by leg. A rescue coordinator keeps a roster of volunteer
drivers, plans a transport on a map, splits it into legs of about 100 miles / 2 hours, asks
drivers to sign up, and builds the itinerary. Drivers see their route, get reminders, and
chat with the rest of the team on that transport.

It runs in any browser, installs to a phone's home screen, and is designed to be hosted
once and shared by many rescues: each organization has its own private space at
`/o/<its-name>`.

## What's inside

| Path | What it is |
|---|---|
| `apps/api` | Node server (Fastify): API, live chat, background jobs. Serves the built web app in production. |
| `apps/web` | The web app (React, Vite, Tailwind, MapLibre). |
| `packages/shared` | Validation schemas and types used by both. |
| `deploy/` | Example systemd unit and nginx config. |

## Requirements

- Node 22 or newer and pnpm
- PostgreSQL 14 or newer

## Getting started (development)

1. `pnpm install`
2. `cp .env.example .env` and fill in the database settings (see below).
3. `pnpm migrate` creates the tables, the restricted app role, and the isolation policies.
4. `pnpm dev` starts the API on port 3000 and the web app on http://localhost:5180.
5. Optional: `pnpm seed` adds a demo rescue with drivers and a transport. The demo logins
   are listed at the top of `apps/api/src/db/seed.ts`.

With `SMTP_URL` empty, emails (invitations, password resets, notifications) are printed in
the API's terminal instead of being sent.

### Database settings

PetXport uses two database logins on purpose:

- `MIGRATION_DATABASE_URL`: an owner login, used only by `pnpm migrate`.
- `DATABASE_URL`: the login the running app uses. It must **not** be a superuser or the
  table owner, because organization isolation is enforced by PostgreSQL row-level security,
  which owners and superusers bypass. `pnpm migrate` creates this role for you (using the
  name and password in `DATABASE_URL`) if the owner login is allowed to create roles. If it
  is not, create it yourself first: `CREATE ROLE petxport_app LOGIN PASSWORD '...';`

`pnpm migrate` refuses to continue if the app role could bypass the isolation policies.

### Tests

`pnpm test` runs against the database in `TEST_DATABASE_URL`, which it wipes. As a guard,
the tests refuse to run unless that database's name ends in `_test`. Create it once
(`CREATE DATABASE petxport_test;`); the test run migrates it itself.

The suite covers the leg-splitting maths, a full transport from request to completion
(including email content and live chat), and a set of isolation tests in which one rescue
tries to read or change another's data through the API and directly in SQL.

## How organizations are kept apart

- Every table that holds a rescue's data has an `org_id` column and a row-level security
  policy that only shows rows for the organization set on the current transaction.
- Request handlers can only reach that data through `withOrg()` in
  `apps/api/src/db/client.ts`, which opens a transaction and sets the organization. A query
  that forgets to filter by organization returns nothing rather than someone else's rows.
- `apps/api/src/db/rls.sql` is re-applied on every migration and covers any table with an
  `org_id` column automatically, so a new table cannot be left unprotected by accident.

## Maps and routing

Map tiles come from [OpenFreeMap](https://openfreemap.org) and need no key.

Routing and address search use [OpenRouteService](https://openrouteservice.org) when
`ORS_API_KEY` is set (free keys allow about 2,000 routes a day). Without a key the app
falls back to the public OSRM and Nominatim demo servers. Those are fine for trying things
out, but their usage policies do not allow production use; set an ORS key, or point
`OSRM_URL` / `NOMINATIM_URL` at servers you run.

### Choosing handoff places

On a transport, "Choose handoff place on map" opens a full-screen map at that handoff.
Zoom in and tap a gas station, rest area, hotel, restaurant or shopping centre, or tap any
spot (a particular corner of a car park) and drag the pin to fine-tune. The route and every
later leg's times are recalculated.

Places come from two sources: the map tiles already on screen (always available once
zoomed in close), and an [Overpass](https://overpass-api.de) lookup that adds rest areas
and street addresses. The public Overpass servers are sometimes busy; when they are, the
picker carries on with the tile data alone. `OVERPASS_URL` takes a comma-separated list of
servers to try, including one you run yourself.

## Notifications

| Channel | Needs |
|---|---|
| Email | `SMTP_URL` (for example `smtps://user:pass@smtp.example.org`) and `MAIL_FROM` |
| Push | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`; run `pnpm vapid` once to generate them |
| Text message | A Twilio account: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |

Each driver chooses their channels on their profile page. Push works in desktop and Android
browsers after the driver turns it on, and on iPhone/iPad once PetXport has been added to
the home screen. Push requires the site to be served over HTTPS (localhost is exempt).

## Deploying

On the server, in a checkout of this repository:

```bash
pnpm install
cp .env.example .env      # then edit: database URLs, APP_URL, SMTP, keys
pnpm migrate
pnpm build
NODE_ENV=production pnpm start
```

- Set `APP_URL` to the public HTTPS address; it is used in email, text and push links and
  makes the login cookie HTTPS-only.
- The server listens on `HOST:PORT` (127.0.0.1:3000 by default). Put a reverse proxy with
  TLS in front of it; `deploy/nginx.conf` is a starting point, and `deploy/petxport.service`
  runs it under systemd.
- To upgrade: pull, `pnpm install`, `pnpm migrate`, `pnpm build`, restart the service.
- Back up the PostgreSQL database; it holds everything.

## Bringing people in

Everyone joins by invitation, and each level invites the one below it.

1. **Platform admin ("super-admin") invites rescues.** List your own email address in
   `PLATFORM_ADMIN_EMAILS` in `.env`, restart, and sign up with that address. You land on
   `/admin`, where you enter a rescue's name and its administrator's name and email. That
   creates the rescue's private space and emails the administrator a link (valid 30 days) to
   choose a password and take it over. From `/admin` you can also re-send an invitation and
   suspend or restore an organization. A platform admin sees who runs each organization and
   how big it is, but not its drivers, transports or messages.
2. **A rescue's admin or coordinator invites drivers.** On the Drivers page, "Invite
   drivers" takes a pasted list of email addresses. Each person gets a link (valid 14 days)
   to choose a password and fill in their own details. "Add with details" and "Import" are
   there for when the coordinator already has the details. Admins invite other coordinators
   and admins in Settings.

By default nobody can create an organization without an invitation. Set
`ALLOW_ORG_SIGNUP=true` if you would rather let any rescue sign itself up.

## Signing in

- **Passwords** are at least 10 characters and stored with Argon2. A new sign-up must open an
  emailed link and re-enter its password before the account works, so nobody can register an
  address they do not own.
- **Passkeys**: on the Account security page (`/account`, linked from My profile) a person
  can add passkeys and then log in with a fingerprint, face or device PIN. Passkeys are bound
  to the host name in `APP_URL`; if you later move the site to a different domain, people
  will need to add them again.
- **Two-step sign-in**: also on Account security. After the password, a 6-digit code is sent
  by email, or by text message when Twilio is configured. A code can always be requested by
  email instead, since the mailbox is already how a forgotten password is recovered. A
  password reset does not bypass it. Signing in with a passkey does not ask for a code,
  because the device has already checked the person.
- Changing these settings, or adding a passkey, asks for the password again.

## Personalising an organization

An organization's admin can upload a logo in Settings; it replaces the paw at the top of every
page for that team. PNG, JPEG or WebP only (never SVG), scaled down in the browser, stored in
the database and visible only to that organization's members.

## Appearance

The app follows the device's light or dark setting. The sun/moon button at the top of every
page switches between the two, and My profile has a three-way choice (Light, Dark, Match
device). The choice is saved per device.

## Security

What is built in:

- Organization data is separated by PostgreSQL row-level security, and the app's database
  role cannot create tables, bypass those policies, or make anyone a platform admin.
- Sessions are httpOnly, SameSite cookies (HTTPS-only when `APP_URL` is https). Requests that
  change anything must come from the site's own origin; so must the chat WebSocket.
- A strict Content-Security-Policy (no inline or third-party scripts), no framing, no
  referrer, HSTS when on HTTPS, and no caching of API responses.
- Rate limits per person and per address, a lock after repeated wrong passwords, caps on
  reset/verification/sign-in-code messages per account, and daily caps on invitation emails
  and notification texts per organization.
- Emailed links are single-use, stored only as hashes, removed from the job queue once sent,
  and redacted from the server log.
- Text-message notifications can only be switched on by the person themself.
- The server will only send web-push messages to the real browser push services.

Before going live, check that:

1. `NODE_ENV=production` and `APP_URL` is your real `https://` address. Requests are rejected
   if the browser's address does not match `APP_URL`.
2. Only the reverse proxy can reach the app's port (it listens on 127.0.0.1 by default), and
   the proxy sets `X-Forwarded-For` to the visitor's address as in `deploy/nginx.conf`.
3. `SMTP_URL` is set (the server refuses to start in production without it).
4. `DATABASE_URL` uses the restricted role and `MIGRATION_DATABASE_URL` the owner;
   `pnpm migrate` checks this.
5. `PLATFORM_ADMIN_EMAILS` lists only mailboxes you control. Turn on a passkey or two-step
   sign-in for those accounts.
6. `.env` is readable only by the service user (`chmod 600 .env`).
7. Never run `pnpm seed` on the server. It creates accounts with a published password and
   refuses to run unless the database name ends in `_dev` or `_test`.
8. The database is backed up, and you re-run `pnpm audit` when you update.

## Roles

- **Platform admin**: creates, invites, suspends and restores organizations at `/admin`.
- **Admin**: organization settings and team membership, plus everything a coordinator can do.
- **Coordinator**: driver roster, transports, volunteer requests, assignments.
- **Driver**: sees the transports they were asked about or are driving, offers to take
  legs, updates their own leg, and joins the chat once confirmed.

Anyone, including coordinators, can fill in a driver profile and drive.
