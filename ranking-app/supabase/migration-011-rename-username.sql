-- ===========================================================================
-- Migration 011: rename a user's username.
-- Run this in the Supabase SQL editor.
--
-- Renames profile "dandanfroghamster" -> "dandanfroghamsterbear".
-- Usernames are stored lowercase and must be unique; this update fails
-- cleanly (unique_violation) if the new name is already taken.
--
-- Note: the signup validation regex allows only 3-20 chars
-- (^[A-Za-z0-9_]{3,20}$); "dandanfroghamsterbear" is 21 chars. There is no
-- CHECK constraint on the column, so this UPDATE succeeds regardless, but the
-- name is one character longer than the app would accept at signup.
-- ===========================================================================

update public.profiles
set username = 'dandanfroghamsterbear'
where username = 'dandanfroghamster';
