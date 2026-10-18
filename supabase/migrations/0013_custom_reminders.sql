-- ═══════════════════════════════════════════════════════════════════
-- Manual ("custom") reminders
--
-- Until now every reminder hung off a task or a calendar event, which
-- stayed the source of truth for its content. A custom reminder is
-- created straight from the Reminders tab and has no owner: the row IS
-- the reminder, and `title` is its text rather than a snapshot.
--
-- source_id is a client-generated id (genId()), so the existing
-- (user_id, source_type, source_id) unique key still gives one row per
-- reminder and saveReminder()'s upsert doubles as "edit".
--
-- Nothing else changes: send-task-reminders already delivers any
-- source_type (a non-task push opens the app at '/'), and
-- upsert_reminders() (0010) restores whatever this constraint allows.
--
-- The inline check in 0001 got Postgres's default name,
-- reminders_source_type_check.
-- ═══════════════════════════════════════════════════════════════════

alter table public.reminders
  drop constraint if exists reminders_source_type_check;

alter table public.reminders
  add constraint reminders_source_type_check
  check (source_type in ('task', 'calendar', 'custom'));
