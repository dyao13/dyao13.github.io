-- Migration 007: expose rank_position and media_type on the
-- community-ratings view so the movie page can show each member's
-- "#rank/total" pills alongside their score.
--
-- Run once in the Supabase SQL editor. Fresh installs of schema.sql
-- do not need this.

drop view if exists public.movie_ratings_visible;

create view public.movie_ratings_visible as
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
