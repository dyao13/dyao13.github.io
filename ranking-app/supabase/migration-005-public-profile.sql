-- ===========================================================================
-- Migration 005: public (logged-out) view of chosen users' rankings.
-- Run this in the Supabase SQL editor. (Fresh installs of schema.sql
-- include everything except the final UPDATE, which is personal.)
--
-- Adds profiles.is_public and a read-only view exposing ONLY public
-- profiles' ranked lists (bucket, rank, score, movie info) to anonymous
-- visitors. Watch history, notes, friendships, and every other table stay
-- login-only. A profile is never public unless explicitly marked.
-- ===========================================================================

alter table public.profiles
  add column if not exists is_public boolean not null default false;

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
  m.director
from public.ratings r
join public.profiles p on p.id = r.user_id
join public.movies m on m.id = r.movie_id
where p.is_public;

revoke all on public.public_rankings from public;
grant select on public.public_rankings to anon, authenticated;

-- Make your own rankings public (edit the username if needed):
update public.profiles set is_public = true where username = 'dandanfroghamster';
