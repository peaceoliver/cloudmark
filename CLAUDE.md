# CloudMark – guide for AI assistants

Read this before changing anything. It explains how the project is built, how to add a feature, and the
rules that keep the four views looking and behaving the same.

User-facing docs: `HOW-IT-WORKS.md` (Hungarian, describes behaviour). Planning history and screenshots live
outside the repo in the project's shared folder (`cloudmark-plan/*.md`).

## Working rules (from the owner)

- **Plan first.** For a new feature or a visible change, write a short plan (what the user gets, options with
  one recommended, what changes in the DB) and implement only after the owner approves it. Small bug fixes
  can go straight to a PR.
- **Naming:** folders, file names, DB tables and columns, JS identifiers and API paths are English.
  **All UI text is Hungarian** (labels, tooltips, toasts, errors returned by the API, e-mails).
- The owner writes Hungarian; answer in Hungarian.
- **No CI.** Run `npm test` and a syntax check (`node --check <file>`) yourself before pushing.
- Every PR updates `HOW-IT-WORKS.md` when user-visible behaviour changes, and this file when a pattern changes.
- Don't rotate the VAPID keys (every device would have to subscribe again).

## Stack and hosting

- Node + Express (`server.js`, `routes/*.js`), PostgreSQL on **Supabase**, hosted on **Render** (free
  instance, sleeps when idle). No build step, no framework: the front end is plain HTML/CSS/JS in `public/`.
- Libraries the browser gets from CDNs: Font Awesome and Google Fonts only. The CSP (`helmet` in
  `server.js`) allows scripts only from `'self'`, so new libraries must be vendored into `public/js/`.
  Inline `onclick=` handlers are allowed (`scriptSrcAttr 'unsafe-inline'`), but prefer `addEventListener`.
- Auth is a session cookie (`requireAuth`, `requireAdmin` middleware). Service-worker and e-mail actions
  use signed action tokens instead (`routes/push.js`).
- Environment variables: `DATABASE_URL`, `APP_URL`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `SMTP_*`, `NOTIFICATIONS_INTERVAL_MS`, `PORT`.
  E-mail only reaches the Resend owner address until a domain is verified.
- Reminders are triggered by Supabase `pg_cron` calling the server (`docs/notification-scheduler.md`).

## Layout

```
server.js               app setup, auth, bookmarks, categories, tags, settings, admin, backup, schema bootstrap
routes/items.js         commands + notes + tasks CRUD (shared `items` table), import/export
routes/tasks.js         task-only endpoints (complete, snooze, reminders)
routes/notifications.js bell, e-mail reminders, daily digest, internal cron endpoint
routes/push.js          Web Push subscriptions and action tokens
migrations/NNN_*.sql    schema changes, run on every server start
public/index.html       the whole single-page UI (all four views are in this file)
public/css/styles.css   one stylesheet, themed with CSS variables
public/js/*.js          one IIFE per feature, exposed on window.CloudMark.<name>
public/sw.js            service worker (install/offline page/push), never caches /api
test/*.test.js          node:test unit tests (`npm test`)
```

## Data model

- `bookmarks` keeps its own table. Everything else is a row in **`items`** with `type` = `command`,
  `note` or `task`. Shared columns: title, description, body, category_id, color, pinned, starred,
  archived, trashed, position, use_count, extra (jsonb). Task-only columns (status, priority, due_at,
  recurrence_rule, parent_item_id …) must be NULL for other types (check constraint `items_task_fields`).
- `item_fragments` (code tabs of a command), `item_tags` (→ `tags`), `item_reminders`, `item_links`.
- `categories.kind` separates categories per type (`bookmark`, `command`, `note`, `task`; tasks call them
  "projektek" in the UI). Names are unique per owner + kind.
- A new content type should become a new `items.type` value (extend the check constraint in a migration),
  not a new table, unless it really doesn't fit.
- Per-user UI settings live in `settings_user` (key/value), written through `PUT /api/user/settings/:key`.

## Migrations

- Add `migrations/NNN_short_name.sql` with the next number, and load it in the schema bootstrap in
  `server.js` (search for `008_push.sql`), with a one-line Hungarian comment above it.
- **Every statement must be idempotent** (`IF NOT EXISTS`, `DO $$ … IF NOT EXISTS (SELECT … pg_constraint) …`),
  because the files run on every start. Never drop user data.
- When you add a table that holds user content, add it to the admin backup export/import in `server.js`
  (`/api/admin/backup/export` and `/import`).

## Front end: the views pattern

The signed-in main page has four views, in this tab order: **Jegyzetek, Feladatok, Könyvjelzők, Parancsok**
(Alt+1…4 follow the order, default view = notes). `public/js/views.js` owns switching:

- Each view is a `<div class="app-view" id="<name>View" data-view="<name>" hidden>` in `index.html` and a tab
  button with `data-view-tab="<name>"` in `#appTabs`.
- `VIEWS` maps a view to its hash (`#/jegyzetek` …) and its search input id. `SHORTCUTS` maps Alt+digit.
- Each view module exposes `window.CloudMark.<name> = { show, reset, … }`. `show()` loads data lazily the
  first time; `reset()` clears state on user change. `N` opens the view's new-item control, `/` focuses
  its search.
- Adding a view: markup in `index.html`, a `public/js/<name>-ui.js` module, entries in `VIEWS`,
  `SHORTCUTS`, the `show`/`reset`/`N` branches of `views.js`, and its prefs (below).

### Toolbar order (identical in every view, top to bottom)

1. **New-item bar**: `<button class="new-item-bar">` with `.new-item-icon` + `.new-item-text`
   ("+ Új …" / "Jegyzet írása…"), 50px tall, inside `section.add-item-section`. What opens sits directly
   under the bar: bookmark and command forms open inline (`commandNewPanel`), the note composer opens under
   it, tasks use the quick-add input (keep it, the owner likes it). Editing an existing command stays in a modal.
2. **Kategóriák** row (`section.category-section`, `.categories-bar`, label `.toolbar-label`); tasks show
   projects here.
3. **Keresés** (`section.enterprise-toolbar` → `.enterprise-search` input with a clear button).
4. **One row** `.bookmark-list-toolbar.item-list-toolbar`: sort `<select>`, state buttons
   (`.bookmark-state-group`, e.g. Aktív / Kedvencek / Archívum / Kuka), then `.item-toolbar-end` with the
   view switcher (`.view-switcher` → `.view-btn[data-view-mode]`) and the **⋮** menu (`.item-more-btn`).

The Bookmarks view is the reference layout; copy its markup and classes rather than inventing new ones.

### Cards (all four views)

- Category under the title, left aligned, as a blue pill: `<div class="card-meta"><span class="card-category">`.
- Tags at the bottom of the card as `#tag` in blue text: `<div class="card-tags">`. Compact notes and compact
  tasks hide tags.
- Views: commands and notes have grid / compact / list, tasks have list / compact.

### View preferences

`public/js/view-prefs.js` (`window.CloudMark.prefs`) stores sort and view per view: keys `commandSort`,
`commandView`, `noteSort`, `noteView`, `taskSort`, `taskView`. Values are saved in localStorage immediately
and to the account. A new pref key or value must be added in **both** `OPTIONS` in `view-prefs.js` and
`VIEW_PREF_OPTIONS` in `server.js`, otherwise the server rejects it. Listen for the `cloudmark:prefs` event to
redraw after sign-in.

### Current and upcoming patterns (approved plans, being built in another thread)

- **Settings**: every view's ⋮ menu gets the same entries in the same order (Kategóriák kezelése, Címkék
  kezelése, Import / Export, ⚙ Beállítások…), opening one shared tabbed Settings modal (Általános, Jegyzetek,
  Feladatok, Könyvjelzők, Parancsok). New settings belong in that modal, not in a new dialog.
- **Notes kanban**: a fourth view mode `kanban` in the notes view switcher; columns = note categories,
  drag to change category.

Check the code before relying on these: once merged, the code is the source of truth.

## Styling rules

- Use the theme variables from the top of `styles.css` (`--bg-main`, `--bg-card`, `--text-primary`,
  `--text-secondary`, `--accent`, `--border-color`, `--danger`, `--success`, `--warning` …). Both
  `[data-theme="dark"]` and `[data-theme="light"]` must look right; never hard-code colours.
- Reuse the existing classes: `.btn .btn-primary/.btn-secondary`, `.btn-icon`, `.modal-overlay`, cards,
  toolbars. Icons are Font Awesome (`fa-solid` / `fa-regular`).
- Check the phone width too: the toolbar must wrap, no horizontal scroll, composers open on screen.
- Escape every user value put into HTML template strings with the module's `esc()` helper (bookmarks build
  DOM nodes with `textContent` instead).

## Caching / releasing front-end changes

- Scripts and the stylesheet are loaded with a version query (`/js/notes-ui.js?v=20261016-cards`,
  `/css/styles.css?v=…`). When you change a file, bump its `?v=` in `index.html` (format `YYYYMMDD-shortname`).
- When you change `sw.js` or a precached file, bump `VERSION` in `sw.js`. The service worker never handles
  `/api` or cross-origin requests; keep it that way.

## API conventions

- Front end calls go through `public/js/api.js` (`window.CloudMark.api`, `requestJson`). Add a method there
  instead of calling `fetch` in a view.
- Endpoints live under `/api/...`, check ownership (`owner_user_id = req.user.id`), return
  `{ error: '<magyar üzenet>' }` with a 4xx status on bad input, and record important changes with
  `recordAuditEvent`.
- Rate limits and helmet are set up in `server.js`. Open issue: `trust proxy` is `true`, so per-IP limits
  can be spoofed until the correct hop count for Render is set.

## Tests and checks before a PR

```
npm install
npm test                       # node --test test/*.test.js
node --check server.js routes/*.js public/js/*.js
```

Pure logic (parsers, date maths) goes in a module that runs in both Node and the browser, like
`public/js/task-parser.js`, with tests in `test/`. For UI changes, run the app (`npm start` with a
`DATABASE_URL`) or at least open `index.html` flows mentally against the toolbar and card rules above, and
attach screenshots when possible.

## Backlog

Ideas the owner wants are tracked as tasks in the app itself (Feladatok, project "CloudMark"): Command
Palette (Ctrl+K), internal `[[` links, Dashboard, Clipper, images + Mermaid in notes, AI assistant, and a
performance check. `roadmap.md` has the longer history. Each still needs a plan approved before building.
