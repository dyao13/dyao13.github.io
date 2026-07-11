-- Migration 008: lower the yellow bucket's max score from 6.7 to 6.6 so it
-- no longer overlaps the green bucket's min (6.7).
--
-- Run once in the Supabase SQL editor after deploying the matching change to
-- ranking-app/ranking-logic.js (getBucketRange) and supabase/schema.sql
-- (public.score_for_position).

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

  if p_total = 1 then
    return round(v_max, 1);
  end if;

  v_t := p_index::numeric / (p_total - 1);
  return round(v_max - v_t * (v_max - v_min), 1);
end;
$$;

-- Recompute stored scores for every yellow-bucket row using the new range.
-- (rank_position is untouched, so this only rewrites the score column.)
update public.ratings r
set score = public.score_for_position(r.rank_position, sub.v_total::integer, 'yellow'),
    updated_at = now()
from (
  select user_id, media_type, count(*) as v_total
  from public.ratings
  where bucket = 'yellow'
  group by user_id, media_type
) sub
where r.bucket = 'yellow'
  and r.user_id = sub.user_id
  and r.media_type = sub.media_type;
