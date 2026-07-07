# MovieRank — Supabase setup

The `/movies/` page on the site is a static shell; all auth, data, and
privacy rules live in [Supabase](https://supabase.com). One-time setup:

## 1. Create a Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project
   (the free tier is fine).
2. Wait for the project to finish provisioning.

## 2. Run the schema

1. Open **SQL Editor** in the Supabase dashboard.
2. Paste the entire contents of [`schema.sql`](schema.sql) and run it.

This creates all tables, enables Row Level Security everywhere, defines the
RPC functions the frontend calls, and inserts one bootstrap invite code.

To read the bootstrap invite code (needed for the very first signup):

```sql
select code from invite_codes where claimed_by is null;
```

After that, any signed-up member can generate invite codes from the
**Friends** page in the app.

## 3. Configure the frontend

Open **Project Settings → API** in the Supabase dashboard and copy:

- the **Project URL**
- the **anon (public)** key

Paste both into [`assets/js/movies-config.js`](../assets/js/movies-config.js).

The anon key is safe to commit **only because** RLS is enabled on every
table by `schema.sql`. Never put the `service_role` key anywhere in this
repository.

## 4. Auth settings (recommended)

In **Authentication → Providers → Email**:

- Email/password sign-in is used by the app.
- If "Confirm email" is enabled (the default), new users must click the
  confirmation link before logging in; the app tells them so. You may
  disable confirmation for a small friends-only app if you prefer.

In **Authentication → URL Configuration**, set the Site URL to
`https://dyao13.github.io/movies/`.

## 5. Verify security

After setup, confirm in the SQL editor that RLS is on for every app table:

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';
```

Every row should show `relrowsecurity = true`.

Behavior enforced by the policies:

- Logged-out visitors cannot read or write any app data.
- Signed-up users without a claimed invite code (no profile) cannot read
  profiles, movies, or anything else.
- Users can modify only their own ratings, watch events, and friendships.
- Ratings and watch activity are visible only to the owner and accepted
  friends; private notes on watch events are visible only to their author.
- Invite codes can never be listed by clients; they are only validated
  through the `claim_invite_and_create_profile` function.

## 6. Movie search (TMDB) — optional

The add-movie flow can search [TMDB](https://www.themoviedb.org) so titles,
years, posters, and directors fill in automatically:

1. Create a free account at themoviedb.org.
2. Go to **Settings → API** and request an API key (choose "Developer";
   any personal-use description is fine).
3. Paste either the **API Key** (v3) or the **API Read Access Token** (v4)
   into `TMDB_API_KEY` in
   [`assets/js/movies-config.js`](../assets/js/movies-config.js).

Without a key, the app falls back to manual title/year entry.

## 7. Community ratings

The movie detail page shows what every member rated a movie (plus the
average) via the `movie_ratings_visible` view. Members who set
`is_private = true` on their profile are only visible to their accepted
friends. If you ran `schema.sql` before this view existed, run
[`migration-002-community-ratings.sql`](migration-002-community-ratings.sql)
once in the SQL editor.

## Ranking data model (for reference)

- `ratings.rank_position` (0 = best, per user per bucket) is the canonical
  order; the one-decimal `score` is derived from it.
- All rank/score writes go through the `rank_movie` and `remove_rating`
  RPCs, which update a whole bucket in one transaction and reject stale
  orderings (e.g. from a second open tab).
