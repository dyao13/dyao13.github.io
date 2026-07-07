# MovieRank — Supabase setup

The `/books/`, `/movies/`, and `/shows/` pages on the site are static
shells sharing one app; all auth, data, and privacy rules live in
[Supabase](https://supabase.com). Each medium has fully independent
green/yellow/red lists per user. One-time setup:

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

### IMDb / Rotten Tomatoes ratings (OMDb) — optional

With an [OMDb](https://www.omdbapi.com) key, search results and movie
detail pages also show the IMDb rating and the Rotten Tomatoes critics
score (the audience score has no public API):

1. Request a free key at <https://www.omdbapi.com/apikey.aspx>
   (1,000 requests/day tier).
2. Activate it via the link OMDb emails you.
3. Paste it into `OMDB_API_KEY` in
   [`assets/js/movies-config.js`](../assets/js/movies-config.js).
4. Run [`migration-004-imdb-id.sql`](migration-004-imdb-id.sql) once in the
   SQL editor (adds `movies.imdb_id` for precise lookups; fresh installs
   of `schema.sql` already have it).

## 7. Community ratings

The movie detail page shows what every member rated a movie (plus the
average) via the `movie_ratings_visible` view. Members who set
`is_private = true` on their profile are only visible to their accepted
friends. If you ran `schema.sql` before this view existed, run
[`migration-002-community-ratings.sql`](migration-002-community-ratings.sql)
once in the SQL editor.

## 8. Public rankings (logged-out view)

Logged-out visitors to `/movies/` can see one account's ranked lists
(read-only). Two switches control this:

1. `PUBLIC_PROFILE_USERNAME` in
   [`assets/js/movies-config.js`](../assets/js/movies-config.js) — which
   account to display (set to `""` to show only the login screen).
2. `profiles.is_public` in the database — run
   [`migration-005-public-profile.sql`](migration-005-public-profile.sql)
   once; it adds the flag, creates the anonymous-readable
   `public_rankings` view, and marks your account public.

Only bucket, rank, score, and movie info are exposed — watch history,
notes, friends, and all other accounts stay login-only.

## 9. Books and TV shows

The same app powers three pages, selected by `data-media-type` on the
mount div (`movie`, `book`, `tv`). Search providers per medium:

- Movies and shows: TMDB (needs `TMDB_API_KEY`), plus OMDb ratings.
- Books: [Open Library](https://openlibrary.org) — no key needed. No
  IMDb/Rotten Tomatoes ratings for books.

If your database predates this feature, run
[`migration-006-media-types.sql`](migration-006-media-types.sql) once in
the SQL editor. It backfills all existing data as `movie`.

## Migrations, in order

If you set up the database from an older `schema.sql`, run any migration
files you have not yet applied, in numeric order (002 → 006). A fresh
`schema.sql` install needs none of them except the personal `update`
statement at the end of migration 005.

## Ranking data model (for reference)

- `ratings.rank_position` (0 = best, per user per bucket) is the canonical
  order; the one-decimal `score` is derived from it.
- All rank/score writes go through the `rank_movie` and `remove_rating`
  RPCs, which update a whole bucket in one transaction and reject stale
  orderings (e.g. from a second open tab).
