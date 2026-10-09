-- ═══════════════════════════════════════════════════════════════════
-- synced_items — one generic cross-device sync table for every tab that is
-- not tasks / habits / reminders (those have their own typed tables).
--
-- Same design contract as tasks (0008) and habits (0009):
--   • localStorage stays the synchronous source the UI reads; Supabase is the
--     cross-device store the client reconciles against.
--   • Reconciliation is per ITEM, last-write-wins on the app-level "updatedAt".
--     Two devices editing DIFFERENT notes / links / journal days never touch
--     each other's rows — the failure mode of the whole-blob design this
--     replaces, where a stale device overwrote the entire list.
--   • Delete is soft (deleted_at tombstone) so a deletion propagates instead
--     of the item resurrecting from a device that still has it.
--   • Writes go through one atomic RPC whose ON CONFLICT ... WHERE makes the
--     LWW compare a single indivisible operation.
--
-- WHY ONE GENERIC TABLE, NOT ONE TABLE PER TAB: ~12 collections with unrelated
-- shapes (notes, links, countdowns, journal days, calendar events, trackers,
-- settings, logs…). A typed table each would be 12 migrations + 12 RPCs that
-- the client would then have to keep in lockstep with every UI field change.
-- The payload is opaque jsonb in `data`; only the sync metadata is typed.
-- ═══════════════════════════════════════════════════════════════════

create table public.synced_items (
  user_id      uuid        not null references auth.users(id) on delete cascade,

  -- Which tab's data this row belongs to ('notes', 'links', 'journal', …).
  -- Lower-snake only, so a hand-crafted request can't smuggle odd keys in.
  collection   text        not null check (collection ~ '^[a-z][a-z0-9_]{0,39}$'),

  -- Client-generated item id (base36 timestamp + random, an ISO date for
  -- journal days, a fixed name for single-document settings).
  id           text        not null check (length(id) between 1 and 200),

  -- The item itself, verbatim from the localStorage shape. Tombstones carry {}.
  data         jsonb       not null default '{}'::jsonb,

  -- DRIVES last-write-wins. Stamped by the client at edit time.
  "updatedAt"  timestamptz not null,

  deleted_at   timestamptz,                         -- soft-delete tombstone

  -- Server-side infra columns. updated_at is set by the trigger from the DB
  -- clock, so the incremental pull cursor never depends on a device clock.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (user_id, collection, id)
);

-- Incremental pull: "everything that changed on the server since my cursor".
create index idx_synced_items_user_updated
  on public.synced_items (user_id, updated_at);

-- Per-collection newest-first scans (log retention below).
create index idx_synced_items_user_coll_edit
  on public.synced_items (user_id, collection, "updatedAt" desc);

-- Reuses public.set_updated_at() defined in 0001_reminders.sql.
create trigger synced_items_set_updated_at
  before update on public.synced_items
  for each row execute function public.set_updated_at();

alter table public.synced_items enable row level security;

create policy "Users can view their own synced items"
  on public.synced_items for select
  using (auth.uid() = user_id);

create policy "Users can insert their own synced items"
  on public.synced_items for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own synced items"
  on public.synced_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own synced items"
  on public.synced_items for delete
  using (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════════
-- upsert_synced_items(p_items jsonb) — atomic, last-write-wins bulk upsert
--
-- p_items: [{ collection, id, data, updatedAt, deleted_at? }, …]
--
-- Returns one row per input item telling the client what the server holds
-- afterwards:
--   accepted = true   the write won (or was new) — `data` is returned null to
--                     save bandwidth, the client already has it.
--   accepted = false  a strictly NEWER version already existed (another device
--                     edited later) — the server's row is returned in full so
--                     the client adopts it instead of retrying forever.
--
-- user_id is always auth.uid(), never read from the payload, so a hand-edited
-- request naming another user cannot reach their rows.
-- ═══════════════════════════════════════════════════════════════════
create or replace function public.upsert_synced_items(p_items jsonb)
returns table (
  collection   text,
  id           text,
  "updatedAt"  timestamptz,
  deleted_at   timestamptz,
  accepted     boolean,
  data         jsonb
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  -- The RETURNS TABLE column names (collection, id, …) double as plpgsql
  -- variables, which makes `on conflict (user_id, collection, id)` ambiguous.
  -- use_column resolves every bare name in SQL text to the TABLE column; the
  -- OUT variables are only ever assigned (`collection := …`), never read.
  elem      jsonb;
  rec       public.synced_items;
  stored    public.synced_items;
  won       boolean;
  touched   text[] := '{}';
  cap       record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  for elem in select * from jsonb_array_elements(p_items)
  loop
    rec := jsonb_populate_record(null::public.synced_items, elem);

    -- An item that can't be keyed or ordered can't be reconciled; skip it
    -- rather than abort the transaction and drop every good row with it.
    continue when rec.collection is null or rec.id is null or rec."updatedAt" is null;

    -- CLOCK-SKEW GUARD. Last-write-wins trusts the device's clock, so a device set
    -- to the year 2099 would otherwise outrank every honest edit until then. Edit
    -- times are capped at (server now + 5 min); real skew within that is harmless,
    -- and the client adopts whatever stamp is stored (it is in the result below).
    insert into public.synced_items as s (
      user_id, collection, id, data, "updatedAt", deleted_at
    )
    values (
      auth.uid(), rec.collection, rec.id,
      coalesce(rec.data, '{}'::jsonb),
      least(rec."updatedAt", now() + interval '5 minutes'),
      rec.deleted_at
    )
    on conflict (user_id, collection, id) do update set
      data         = excluded.data,
      "updatedAt"  = excluded."updatedAt",
      deleted_at   = excluded.deleted_at
      -- LWW guard: only overwrite when the incoming edit is strictly newer.
      -- (NULL-safe by construction: "updatedAt" is NOT NULL on both sides, the
      -- hazard 0011 had to repair for tasks/habits cannot occur here.)
      where excluded."updatedAt" > s."updatedAt"
    returning true into won;

    -- `won` is null when the ON CONFLICT ... WHERE rejected the write.
    won := coalesce(won, false);

    select * into stored
      from public.synced_items si
     where si.user_id = auth.uid()
       and si.collection = rec.collection
       and si.id = rec.id;

    collection  := stored.collection;
    id          := stored.id;
    "updatedAt" := stored."updatedAt";
    deleted_at  := stored.deleted_at;
    accepted    := won;
    data        := case when won then null else stored.data end;
    return next;

    if not (rec.collection = any (touched)) then
      touched := touched || rec.collection;
    end if;
  end loop;

  -- ── Retention for append-only logs ─────────────────────────────────
  -- Every device caps these logs locally (2000 entries / 200 messages) and
  -- trims by DROPPING, not by deleting — so without this the server would
  -- keep every row ever written and a new device's first pull would download
  -- years of activity. Hard-deleting the oldest rows is safe because log
  -- entries are immutable and every device applies the same cap.
  -- Only the log collections this call actually touched, so ordinary writes
  -- (a note edit) never pay for a retention scan.
  for cap in
    select t.coll, t.keep
      from (values ('activity_log', 2500), ('pomo_log', 2500), ('chat_history', 300))
           as t (coll, keep)
     where t.coll = any (touched)
  loop
    -- OFFSET takes a plpgsql variable (cap.keep) but not a correlated column,
    -- hence the loop instead of one DELETE ... USING.
    -- The subquery yields the `keep`-th newest edit time (offset is 0-based,
    -- hence keep - 1); everything strictly older goes. When fewer than `keep`
    -- rows exist it is NULL, the comparison is NULL, and nothing is deleted.
    delete from public.synced_items s
     where s.user_id = auth.uid()
       and s.collection = cap.coll
       and s."updatedAt" < (
         select x."updatedAt"
           from public.synced_items x
          where x.user_id = auth.uid() and x.collection = cap.coll
          order by x."updatedAt" desc
          offset cap.keep - 1 limit 1
       );
  end loop;
end;
$$;

-- Signed-in users only; the auth.uid() guard and RLS do the rest.
revoke all on function public.upsert_synced_items(jsonb) from public, anon;
grant execute on function public.upsert_synced_items(jsonb) to authenticated;


-- Enables the Realtime subscription. Required, not optional, on this project:
-- it does not publish all tables (verified when adding tasks in 0008).
alter publication supabase_realtime add table public.synced_items;
