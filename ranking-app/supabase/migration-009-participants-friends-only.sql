-- Migration 009: watch-event participants must be accepted friends of the
-- event owner. Previously any registered user could be listed; now the
-- insert policy also requires an accepted friendship, matching the frontend,
-- which only offers friends in the "With whom" search.
--
-- Run once in the Supabase SQL editor. Existing rows are untouched.

drop policy "wep_insert_own_event" on public.watch_event_participants;

create policy "wep_insert_own_event" on public.watch_event_participants
  for insert to authenticated
  with check (
    exists (
      select 1 from public.watch_events we
      where we.id = watch_event_id and we.user_id = auth.uid()
    )
    and public.is_friends_with(participant_user_id)
  );
