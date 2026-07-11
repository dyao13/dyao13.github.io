-- ===========================================================================
-- Migration 006: books and TV shows.
-- Run this once in the Supabase SQL editor. (Fresh installs of schema.sql
-- already include all of it.)
--
-- Generalizes the catalog to three media types ('movie', 'book', 'tv').
-- Every user gets independent green/yellow/red lists per medium. Existing
-- rows are backfilled as 'movie'.
-- ===========================================================================

-- 1. Catalog: media_type, book ids, and per-medium TMDB dedup
--    (TMDB movie ids and TV ids are separate numbering spaces).

alter table public.movies
  add column if not exists media_type text not null default 'movie';

alter table public.movies
  add constraint movies_media_type_check check (media_type in ('movie', 'book', 'tv'));

alter table public.movies add column if not exists openlibrary_id text;

alter table public.movies drop constraint if exists movies_tmdb_id_key;

create unique index if not exists movies_media_tmdb_key
  on public.movies (media_type, tmdb_id) where tmdb_id is not null;

create unique index if not exists movies_media_openlibrary_key
  on public.movies (media_type, openlibrary_id) where openlibrary_id is not null;

-- 2. Ratings: rank space becomes per user per medium per bucket.

alter table public.ratings
  add column if not exists media_type text not null default 'movie';

alter table public.ratings
  add constraint ratings_media_type_check check (media_type in ('movie', 'book', 'tv'));

update public.ratings r
set media_type = m.media_type
from public.movies m
where r.movie_id = m.id and r.media_type is distinct from m.media_type;

alter table public.ratings drop constraint if exists ratings_user_id_bucket_rank_position_key;

alter table public.ratings
  add constraint ratings_user_media_bucket_rank_key
  unique (user_id, media_type, bucket, rank_position) deferrable initially deferred;

-- 3. Ranking functions become media-aware. rank_movie/remove_rating keep
--    their signatures (the medium is derived from the item being ranked).

drop function if exists public.renormalize_bucket(uuid, text);

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

revoke execute on function public.renormalize_bucket(uuid, text, text) from anon, public;
grant execute on function public.renormalize_bucket(uuid, text, text) to authenticated;

-- 4. Views: expose media_type (columns appended at the end, which
--    create-or-replace allows).

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
