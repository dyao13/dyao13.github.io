-- ===========================================================================
-- Migration 004: add movies.imdb_id.
-- Run this in the Supabase SQL editor if you set up the database before
-- this column was added. (Fresh installs of schema.sql already include it.)
--
-- Used by the OMDb integration to look up IMDb / Rotten Tomatoes ratings
-- precisely. Movies added before this migration simply have imdb_id = null;
-- the app falls back to a title + year lookup for them.
-- ===========================================================================

alter table public.movies add column if not exists imdb_id text;
