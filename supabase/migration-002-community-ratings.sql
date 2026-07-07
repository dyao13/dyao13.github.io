-- ===========================================================================
-- Migration 002: community ratings view.
-- Run this in the Supabase SQL editor if you already ran schema.sql before
-- this view was added to it. (Fresh installs of schema.sql include it.)
--
-- Lets any invited member see what other members rated a movie, while still
-- respecting profiles.is_private: a private profile's ratings are visible
-- only to their accepted friends.
-- ===========================================================================

create or replace view public.movie_ratings_visible as
select r.movie_id, r.user_id, r.bucket, r.score, r.updated_at
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
