-- ===========================================================================
-- Migration 003: a lone movie in a bucket scores the bucket MAXIMUM instead
-- of the midpoint (green 10.0, yellow 6.7, red 3.3). Run this in the
-- Supabase SQL editor if you set up the database before this change.
-- (Fresh installs of schema.sql already include it.)
--
-- Also recomputes all existing scores so stored data matches the new rule.
-- ===========================================================================

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
    v_min := 3.4; v_max := 6.7;
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

-- Recompute every user's scores under the new rule.
do $$
declare
  rec record;
begin
  for rec in select distinct user_id, bucket from public.ratings loop
    perform public.renormalize_bucket(rec.user_id, rec.bucket);
  end loop;
end;
$$;
