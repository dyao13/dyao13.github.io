-- ===========================================================================
-- Migration 010: ties ("About the same" in pairwise comparisons).
--
-- Movies judged about the same share a rank_position — their tie group —
-- and therefore a score. Scores are computed per unique tie group, so the
-- distinct score levels within a bucket stay evenly spaced.
--
-- Run once in the Supabase SQL editor. Fresh installs of schema.sql do not
-- need this file. Existing data is unaffected: every current movie simply
-- remains its own tie group.
-- ===========================================================================

-- 1. rank_position is no longer unique within a bucket (tied movies share
--    it). The constraint name is auto-generated, so find it by its columns.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.ratings'::regclass
      and c.contype = 'u'
      and exists (
        select 1
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
        where a.attname = 'rank_position'
      )
  loop
    execute format('alter table public.ratings drop constraint %I', r.conname);
  end loop;
end $$;

create index if not exists ratings_user_bucket_rank_idx
  on public.ratings (user_id, media_type, bucket, rank_position);

-- 2. A tie recorded in the comparison history has no preferred movie.
alter table public.pairwise_comparisons
  alter column preferred_movie_id drop not null;

-- 3. Renormalizing a bucket must preserve tie groups: dense_rank keeps tied
--    rows together while closing any gaps, and scores are spaced over the
--    number of distinct groups, not the number of movies.
create or replace function public.renormalize_bucket(p_user uuid, p_media_type text, p_bucket text)
returns void
language plpgsql
as $$
declare
  v_total integer;
begin
  select count(distinct rank_position) into v_total
  from ratings
  where user_id = p_user and media_type = p_media_type and bucket = p_bucket;

  update ratings r
  set rank_position = sub.new_pos,
      score = public.score_for_position(sub.new_pos, v_total, p_bucket),
      updated_at = now()
  from (
    select id, (dense_rank() over (order by rank_position))::integer - 1 as new_pos
    from ratings
    where user_id = p_user and media_type = p_media_type and bucket = p_bucket
  ) sub
  where r.id = sub.id;
end;
$$;

-- 4. rank_movie gains an optional parallel array of tie-group indices
--    (dense, non-decreasing, starting at 0). Omitted or null means every
--    movie is its own group — exactly the old behavior, so pre-010 clients
--    keep working. Postgres would otherwise keep the 3-argument version
--    around as an ambiguous overload, so drop it first.
drop function if exists public.rank_movie(uuid, text, uuid[]);

create or replace function public.rank_movie(
  p_movie_id uuid,
  p_bucket text,
  p_ordered_movie_ids uuid[],
  p_group_indices integer[] default null
)
returns void
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
  v_media_type text;
  v_old_bucket text;
  v_total integer := coalesce(array_length(p_ordered_movie_ids, 1), 0);
  v_groups integer[] := p_group_indices;
  v_group_count integer;
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

  if v_groups is null then
    select array_agg(g - 1) into v_groups from generate_series(1, v_total) g;
  end if;

  if coalesce(array_length(v_groups, 1), 0) <> v_total then
    raise exception 'Group list must match the ordered list';
  end if;

  if v_groups[1] <> 0 then
    raise exception 'Group indices must start at 0';
  end if;

  for i in 2..v_total loop
    if v_groups[i] <> v_groups[i - 1] and v_groups[i] <> v_groups[i - 1] + 1 then
      raise exception 'Group indices must be dense and non-decreasing';
    end if;
  end loop;

  v_group_count := v_groups[v_total] + 1;

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
      v_groups[i],
      public.score_for_position(v_groups[i], v_group_count, p_bucket),
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

grant execute on function public.rank_movie(uuid, text, uuid[], integer[]) to authenticated;
