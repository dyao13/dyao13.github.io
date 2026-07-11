-- ===========================================================================
-- Ranking app schema for Supabase.
-- Run this whole file once in the Supabase SQL editor (Dashboard -> SQL).
-- It creates the tables, Row Level Security policies, and RPC functions the
-- frontend (ranking-app/ranking-app.js) calls.
-- ===========================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  avatar_url text,
  is_private boolean default false,
  is_public boolean not null default false,
  created_at timestamptz default now()
);

create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_by uuid references public.profiles(id) on delete set null,
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz default now()
);

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

-- Catalog of rankable items. Despite the historical name, this table holds
-- movies, books, and TV shows, distinguished by media_type. The `director`
-- column doubles as author (books) / creator (TV).
create table public.movies (
  id uuid primary key default gen_random_uuid(),
  media_type text not null default 'movie' check (media_type in ('movie', 'book', 'tv')),
  tmdb_id integer,
  imdb_id text,
  openlibrary_id text,
  title text not null,
  release_year integer,
  poster_url text,
  director text,
  created_at timestamptz default now()
);

-- TMDB movie ids and TV ids are separate numbering spaces, so dedup is
-- scoped per medium.
create unique index movies_media_tmdb_key
  on public.movies (media_type, tmdb_id) where tmdb_id is not null;

create unique index movies_media_openlibrary_key
  on public.movies (media_type, openlibrary_id) where openlibrary_id is not null;

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  movie_id uuid not null references public.movies(id) on delete cascade,
  media_type text not null check (media_type in ('movie', 'book', 'tv')),
  bucket text not null check (bucket in ('green', 'yellow', 'red')),
  rank_position integer not null,
  score numeric(3,1) not null,
  updated_at timestamptz default now(),
  unique (user_id, movie_id),
  unique (user_id, media_type, bucket, rank_position) deferrable initially deferred
);

create table public.watch_events (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid not null references public.movies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  watched_on date,
  notes text,
  context text,
  created_at timestamptz default now()
);

create table public.watch_event_participants (
  id uuid primary key default gen_random_uuid(),
  watch_event_id uuid not null references public.watch_events(id) on delete cascade,
  participant_user_id uuid not null references public.profiles(id) on delete cascade,
  unique (watch_event_id, participant_user_id)
);

create table public.pairwise_comparisons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  new_movie_id uuid not null references public.movies(id) on delete cascade,
  compared_movie_id uuid not null references public.movies(id) on delete cascade,
  preferred_movie_id uuid not null references public.movies(id) on delete cascade,
  bucket text not null check (bucket in ('green', 'yellow', 'red')),
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions used by RLS policies
-- ---------------------------------------------------------------------------

-- True when the calling user has completed profile setup (i.e. passed the
-- invite gate). Security definer so it can read profiles regardless of the
-- caller's row visibility.
create or replace function public.has_profile()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid());
$$;

-- True when the calling user and `other` are accepted friends.
create or replace function public.is_friends_with(other uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;

-- True when the calling user may see a watch event (their own, or an
-- accepted friend's).
create or replace function public.can_view_watch_event(p_event_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from watch_events we
    where we.id = p_event_id
      and (we.user_id = auth.uid() or public.is_friends_with(we.user_id))
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.invite_codes enable row level security;
alter table public.friendships enable row level security;
alter table public.movies enable row level security;
alter table public.ratings enable row level security;
alter table public.watch_events enable row level security;
alter table public.watch_event_participants enable row level security;
alter table public.pairwise_comparisons enable row level security;

-- profiles: readable by invited (profiled) users for friend search; users
-- update only their own row. Inserts happen only through
-- claim_invite_and_create_profile(), so there is no insert policy.
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (public.has_profile());

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- invite_codes: no policies. All access goes through the security-definer
-- RPCs below, so codes can never be listed by clients.

-- friendships
create policy "friendships_select_own" on public.friendships
  for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy "friendships_insert_request" on public.friendships
  for insert to authenticated
  with check (
    requester_id = auth.uid()
    and status = 'pending'
    and public.has_profile()
  );

create policy "friendships_update_addressee" on public.friendships
  for update to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

create policy "friendships_delete_own" on public.friendships
  for delete to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- An addressee may change a request's status but never who is involved.
create or replace function public.friendships_lock_parties()
returns trigger
language plpgsql
as $$
begin
  if new.requester_id <> old.requester_id or new.addressee_id <> old.addressee_id then
    raise exception 'Cannot change the users on a friendship';
  end if;
  return new;
end;
$$;

create trigger friendships_lock_parties
  before update on public.friendships
  for each row execute function public.friendships_lock_parties();

-- Prevent a reverse duplicate (B->A when A->B already exists).
create or replace function public.friendships_no_reverse_duplicate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1 from friendships f
    where f.requester_id = new.addressee_id
      and f.addressee_id = new.requester_id
  ) then
    raise exception 'A friendship or request between these users already exists';
  end if;
  return new;
end;
$$;

create trigger friendships_no_reverse_duplicate
  before insert on public.friendships
  for each row execute function public.friendships_no_reverse_duplicate();

-- movies: shared catalog. Invited users can read and add; no client updates
-- or deletes.
create policy "movies_select" on public.movies
  for select to authenticated
  using (public.has_profile());

create policy "movies_insert" on public.movies
  for insert to authenticated
  with check (public.has_profile());

-- ratings: own everything; accepted friends may read.
create policy "ratings_select_own_or_friends" on public.ratings
  for select to authenticated
  using (user_id = auth.uid() or public.is_friends_with(user_id));

create policy "ratings_insert_own" on public.ratings
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "ratings_update_own" on public.ratings
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "ratings_delete_own" on public.ratings
  for delete to authenticated
  using (user_id = auth.uid());

-- watch_events: direct table access is owner-only. Friends read through the
-- watch_events_feed view below, which hides private notes.
create policy "watch_events_select_own" on public.watch_events
  for select to authenticated
  using (user_id = auth.uid());

create policy "watch_events_insert_own" on public.watch_events
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "watch_events_update_own" on public.watch_events
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "watch_events_delete_own" on public.watch_events
  for delete to authenticated
  using (user_id = auth.uid());

-- watch_event_participants
create policy "wep_select_visible" on public.watch_event_participants
  for select to authenticated
  using (public.can_view_watch_event(watch_event_id));

-- Participants must be accepted friends of the event owner.
create policy "wep_insert_own_event" on public.watch_event_participants
  for insert to authenticated
  with check (
    exists (
      select 1 from public.watch_events we
      where we.id = watch_event_id and we.user_id = auth.uid()
    )
    and public.is_friends_with(participant_user_id)
  );

create policy "wep_delete_own_event" on public.watch_event_participants
  for delete to authenticated
  using (
    exists (
      select 1 from public.watch_events we
      where we.id = watch_event_id and we.user_id = auth.uid()
    )
  );

-- pairwise_comparisons: private to each user.
create policy "pairwise_select_own" on public.pairwise_comparisons
  for select to authenticated
  using (user_id = auth.uid());

create policy "pairwise_insert_own" on public.pairwise_comparisons
  for insert to authenticated
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Friend activity feed view.
-- Definer-rights view (bypasses the owner-only RLS above) that applies its
-- own visibility rule and blanks `notes` unless the caller is the author.
-- ---------------------------------------------------------------------------

create or replace view public.watch_events_feed as
select
  we.id,
  we.movie_id,
  we.user_id,
  we.watched_on,
  we.context,
  we.created_at,
  case when we.user_id = auth.uid() then we.notes else null end as notes,
  m.media_type
from public.watch_events we
join public.movies m on m.id = we.movie_id
where we.user_id = auth.uid() or public.is_friends_with(we.user_id);

revoke all on public.watch_events_feed from anon, public;
grant select on public.watch_events_feed to authenticated;

-- ---------------------------------------------------------------------------
-- Community ratings view.
-- Lets any invited member see what other members rated a movie (used on the
-- movie detail page), while still respecting profiles.is_private: a private
-- profile's ratings are visible only to their accepted friends.
-- Definer-rights view; the base ratings table stays owner-or-friends only.
-- ---------------------------------------------------------------------------

create or replace view public.movie_ratings_visible as
select r.movie_id, r.user_id, r.bucket, r.rank_position, r.score, r.media_type, r.updated_at
from public.ratings r
join public.profiles p on p.id = r.user_id
where public.has_profile()
  and (
    r.user_id = auth.uid()
    or public.is_friends_with(r.user_id)
    or not coalesce(p.is_private, false)
  );

revoke all on public.movie_ratings_visible from anon, public;
grant select on public.movie_ratings_visible to authenticated;

-- ---------------------------------------------------------------------------
-- Public rankings view.
-- Read-only, available WITHOUT login, and only for profiles explicitly
-- marked is_public = true (e.g. the site owner's own list, shown to
-- logged-out visitors of /movies/). Everything else stays login-only.
-- ---------------------------------------------------------------------------

create or replace view public.public_rankings as
select
  p.username,
  p.display_name,
  r.movie_id,
  r.bucket,
  r.rank_position,
  r.score,
  m.title,
  m.release_year,
  m.poster_url,
  m.director,
  m.media_type
from public.ratings r
join public.profiles p on p.id = r.user_id
join public.movies m on m.id = r.movie_id
where p.is_public;

revoke all on public.public_rankings from public;
grant select on public.public_rankings to anon, authenticated;

-- To publish a user's rankings to logged-out visitors:
--   update profiles set is_public = true where username = 'your-username';

-- ---------------------------------------------------------------------------
-- Scoring + ranking functions
-- ---------------------------------------------------------------------------

-- Mirrors scoreForPosition() in ranking-app/ranking-logic.js.
create or replace function public.score_for_position(p_index integer, p_total integer, p_bucket text)
returns numeric
language plpgsql immutable
as $$
declare
  v_min numeric;
  v_max numeric;
  v_t numeric;
begin
  if p_bucket = 'green' then
    v_min := 6.7; v_max := 10.0;
  elsif p_bucket = 'yellow' then
    v_min := 3.4; v_max := 6.6;
  elsif p_bucket = 'red' then
    v_min := 0.0; v_max := 3.3;
  else
    raise exception 'Unknown bucket: %', p_bucket;
  end if;

  -- A lone movie sits at the top of its bucket.
  if p_total = 1 then
    return round(v_max, 1);
  end if;

  v_t := p_index::numeric / (p_total - 1);
  return round(v_max - v_t * (v_max - v_min), 1);
end;
$$;

-- Re-assign rank_position 0..n-1 (preserving current order) and recompute
-- scores for one user's bucket within one medium. Runs with invoker rights,
-- so RLS still guarantees users can only touch their own rows.
create or replace function public.renormalize_bucket(p_user uuid, p_media_type text, p_bucket text)
returns void
language plpgsql
as $$
declare
  v_total integer;
begin
  select count(*) into v_total
  from ratings
  where user_id = p_user and media_type = p_media_type and bucket = p_bucket;

  update ratings r
  set rank_position = sub.new_pos,
      score = public.score_for_position(sub.new_pos, v_total, p_bucket),
      updated_at = now()
  from (
    select id, (row_number() over (order by rank_position))::integer - 1 as new_pos
    from ratings
    where user_id = p_user and media_type = p_media_type and bucket = p_bucket
  ) sub
  where r.id = sub.id;
end;
$$;

-- Atomically place p_movie_id in p_bucket using the complete desired order
-- of that bucket (best first). Handles new ratings, re-ranks, and bucket
-- changes; when a movie moves buckets, the old bucket is renormalized in the
-- same transaction. Raises if the provided order is stale (e.g. another tab
-- changed the bucket), so the client can reload and retry.
create or replace function public.rank_movie(
  p_movie_id uuid,
  p_bucket text,
  p_ordered_movie_ids uuid[]
)
returns void
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
  v_media_type text;
  v_old_bucket text;
  v_total integer := coalesce(array_length(p_ordered_movie_ids, 1), 0);
  i integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_bucket not in ('green', 'yellow', 'red') then
    raise exception 'Unknown bucket: %', p_bucket;
  end if;

  if v_total = 0 then
    raise exception 'Ordered list is empty';
  end if;

  if not (p_movie_id = any (p_ordered_movie_ids)) then
    raise exception 'Item is not in the ordered list';
  end if;

  if (select count(distinct m) from unnest(p_ordered_movie_ids) m) <> v_total then
    raise exception 'Ordered list contains duplicates';
  end if;

  select media_type into v_media_type from movies where id = p_movie_id;
  if v_media_type is null then
    raise exception 'Unknown item';
  end if;

  -- Every id must be a real catalog item of the same medium.
  if (select count(*) from movies where id = any (p_ordered_movie_ids) and media_type = v_media_type) <> v_total then
    raise exception 'Ordered list mixes media types or contains an unknown item';
  end if;

  -- The list must contain every item currently rated in this bucket...
  if exists (
    select 1 from ratings r
    where r.user_id = v_uid and r.media_type = v_media_type and r.bucket = p_bucket
      and not (r.movie_id = any (p_ordered_movie_ids))
  ) then
    raise exception 'Ranking is out of date; please reload and try again';
  end if;

  -- ...and nothing else besides the item being placed.
  if exists (
    select 1 from unnest(p_ordered_movie_ids) m
    where m <> p_movie_id
      and not exists (
        select 1 from ratings r
        where r.user_id = v_uid and r.media_type = v_media_type
          and r.bucket = p_bucket and r.movie_id = m
      )
  ) then
    raise exception 'Ranking is out of date; please reload and try again';
  end if;

  select bucket into v_old_bucket
  from ratings
  where user_id = v_uid and movie_id = p_movie_id;

  for i in 1..v_total loop
    insert into ratings (user_id, movie_id, media_type, bucket, rank_position, score, updated_at)
    values (
      v_uid,
      p_ordered_movie_ids[i],
      v_media_type,
      p_bucket,
      i - 1,
      public.score_for_position(i - 1, v_total, p_bucket),
      now()
    )
    on conflict (user_id, movie_id) do update
      set bucket = excluded.bucket,
          rank_position = excluded.rank_position,
          score = excluded.score,
          updated_at = excluded.updated_at;
  end loop;

  if v_old_bucket is not null and v_old_bucket <> p_bucket then
    perform public.renormalize_bucket(v_uid, v_media_type, v_old_bucket);
  end if;
end;
$$;

-- Delete a rating and close the gap it leaves in its bucket.
create or replace function public.remove_rating(p_movie_id uuid)
returns void
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
  v_bucket text;
  v_media_type text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from ratings
  where user_id = v_uid and movie_id = p_movie_id
  returning bucket, media_type into v_bucket, v_media_type;

  if v_bucket is not null then
    perform public.renormalize_bucket(v_uid, v_media_type, v_bucket);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invite gate
-- ---------------------------------------------------------------------------

-- Called once after signup/login. Validates the invite code, creates the
-- profile, and marks the code claimed — all or nothing. Security definer
-- because clients have no direct access to invite_codes and no insert
-- policy on profiles.
create or replace function public.claim_invite_and_create_profile(
  p_code text,
  p_username text,
  p_display_name text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'You already have a profile';
  end if;

  if p_username is null or p_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Username must be 3-20 characters: letters, numbers, or underscore';
  end if;

  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception 'Display name is required';
  end if;

  select id into v_code_id
  from invite_codes
  where code = p_code and claimed_by is null
  for update;

  if v_code_id is null then
    raise exception 'Invalid or already-used invite code';
  end if;

  begin
    insert into profiles (id, username, display_name)
    values (v_uid, lower(p_username), trim(p_display_name));
  exception when unique_violation then
    raise exception 'That username is already taken';
  end;

  update invite_codes
  set claimed_by = v_uid, claimed_at = now()
  where id = v_code_id;
end;
$$;

-- Any invited member can generate an invite code for a friend.
create or replace function public.create_invite_code()
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
begin
  if v_uid is null or not exists (select 1 from profiles where id = v_uid) then
    raise exception 'Not allowed';
  end if;

  v_code := encode(gen_random_bytes(6), 'hex');

  insert into invite_codes (code, created_by)
  values (v_code, v_uid);

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: only logged-in users may call the RPCs.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from anon, public;
grant execute on function public.has_profile() to authenticated;
grant execute on function public.is_friends_with(uuid) to authenticated;
grant execute on function public.can_view_watch_event(uuid) to authenticated;
grant execute on function public.score_for_position(integer, integer, text) to authenticated;
grant execute on function public.renormalize_bucket(uuid, text, text) to authenticated;
grant execute on function public.rank_movie(uuid, text, uuid[]) to authenticated;
grant execute on function public.remove_rating(uuid) to authenticated;
grant execute on function public.claim_invite_and_create_profile(text, text, text) to authenticated;
grant execute on function public.create_invite_code() to authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap: create the first invite code (no profile exists yet, so
-- create_invite_code() cannot be used for the very first signup).
-- ---------------------------------------------------------------------------

insert into invite_codes (code) values (encode(gen_random_bytes(6), 'hex'));

-- To see it:
--   select code from invite_codes where claimed_by is null;
