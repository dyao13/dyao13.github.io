-- ===========================================================================
-- Migration 007: make invite-code generation find pgcrypto on Supabase.
-- Run this in the Supabase SQL editor if "Generate invite code" fails with:
--   function gen_random_bytes(integer) does not exist
-- ===========================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

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

grant execute on function public.create_invite_code() to authenticated;
