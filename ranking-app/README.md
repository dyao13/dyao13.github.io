# Ranking app

A private, invite-only app for ranking movies, books, and TV shows, built as a
static single-page app with a [Supabase](https://supabase.com) backend. It
powers the [/movies/](https://dyao13.github.io/movies/),
[/books/](https://dyao13.github.io/books/), and
[/shows/](https://dyao13.github.io/shows/) pages of
[dyao13.github.io](https://dyao13.github.io).

## How ranking works

You never type in a score. Instead:

1. **Pick a bucket** for the item: green "I liked it" (6.7–10.0), yellow
   "It was fine" (3.4–6.6), or red "I didn't like it" (0.0–3.3).
2. **Answer pairwise comparisons** ("which did you prefer?", or "about the
   same"). A binary search against your existing list finds the item's exact
   slot in ~log₂(n) questions; answering "about the same" ties the two items
   at the same rating.
3. **Scores are derived from position**: the best item in a bucket gets the
   bucket's maximum, the worst gets the minimum, and the unique rating levels
   in between are evenly spaced (tied items share one level). Every insertion
   re-spaces the whole bucket.

Each medium (movies, books, shows) has fully independent lists. Beyond
ranking, the app tracks watch/read dates with notes and participants, and has
an invite-gated friend system: friends can see each other's rankings and a
shared activity feed.

## Architecture

The frontend is plain ES modules served as static files by the Jekyll site —
no build step, no framework. All dynamic behavior (auth, data, privacy) is
handled client-side against Supabase, with privacy enforced in the database
itself via Row Level Security, so publishing the anon API key is safe.

| Path | Purpose |
| --- | --- |
| [`ranking-app.js`](ranking-app.js) | The app: hash-based routing, views, Supabase calls |
| [`ranking-logic.js`](ranking-logic.js) | Pure ranking/scoring logic (no DOM, no network) |
| [`ranking-config.js`](ranking-config.js) | Supabase project settings + optional API keys |
| [`ranking-app.scss`](ranking-app.scss) | Styles, scoped under `.ranking-app` |
| [`supabase/`](supabase) | Database schema, RLS policies, RPCs, migrations |
| [`tests/`](tests) | Unit tests for the ranking logic |

Search is backed by [TMDB](https://www.themoviedb.org) (movies and TV),
[Open Library](https://openlibrary.org) (books), and
[OMDb](https://www.omdbapi.com) (IMDb / Rotten Tomatoes scores).

## How it's mounted

Jekyll requires include snippets to live in the site's `_includes/`
directory, so the one piece of the app outside this folder is the mount
shim [`_includes/ranking-app.html`](../_includes/ranking-app.html). Each of
the three pages includes it with a media type, e.g.:

```liquid
{% include ranking-app.html media_type="book" %}
```

The shim renders a `<div id="ranking-app" data-media-type="...">` and loads
this folder's stylesheet and script.

## Setup

See [`supabase/README.md`](supabase/README.md) for creating the Supabase
project, running the schema, and generating the first invite code.

## Tests

```sh
node ranking-app/tests/ranking-logic.test.mjs
```
