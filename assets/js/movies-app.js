/*
 * MovieRank — a private movie-ranking app mounted inside the Jekyll site.
 *
 * Jekyll only serves this file; all dynamic behavior (auth, data, privacy)
 * is handled by Supabase. See supabase/schema.sql for the backend and
 * assets/js/movies-ranking.js for the pure ranking/scoring logic.
 *
 * Routing is hash-based so it works on a static host:
 *   #/            dashboard
 *   #/add         add-movie flow
 *   #/rank        bucket + pairwise ranking flow (in-memory)
 *   #/movie/<id>  movie detail
 *   #/friends     friends page
 *   #/profile/<username>  another user's rankings
 */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, TMDB_API_KEY, OMDB_API_KEY, PUBLIC_PROFILE_USERNAME } from "./movies-config.js";
import {
  BUCKETS,
  bucketLabel,
  formatScore,
  createInsertionState,
  isInsertionDone,
  nextComparisonIndex,
  applyComparison,
  insertAt,
  bucketOffsets,
  overallRank,
} from "./movies-ranking.js";

const root = document.getElementById("movies-app");

/*
 * The same app powers /movies/, /books/, and /shows/. Each Jekyll page sets
 * data-media-type on the mount div; everything below adapts to it. Each
 * medium has fully independent green/yellow/red lists per user.
 */
const MEDIA_TYPES = {
  movie: {
    key: "movie",
    label: "Movies",
    path: "/movies/",
    noun: "movie",
    plural: "movies",
    credit: "Directed by",
    verb: "watch",
    verbPast: "watched",
    eventPlural: "watches",
    yearLabel: "Release year (optional)",
    searchPlaceholder: "e.g. Parasite",
    searchAttribution: `Search data from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>.`,
    omdbType: "movie",
  },
  book: {
    key: "book",
    label: "Books",
    path: "/books/",
    noun: "book",
    plural: "books",
    credit: "By",
    verb: "read",
    verbPast: "read",
    eventPlural: "reads",
    yearLabel: "First published (optional)",
    searchPlaceholder: "Title or ISBN, e.g. East of Eden or 9780140186390",
    searchAttribution: `Search data from <a href="https://openlibrary.org" target="_blank" rel="noopener">Open Library</a>.`,
    omdbType: null, // no IMDb/RT ratings for books
  },
  tv: {
    key: "tv",
    label: "Shows",
    path: "/shows/",
    noun: "show",
    plural: "shows",
    credit: "Created by",
    verb: "watch",
    verbPast: "watched",
    eventPlural: "watches",
    yearLabel: "First aired (optional)",
    searchPlaceholder: "e.g. Severance",
    searchAttribution: `Search data from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>.`,
    omdbType: "series",
  },
};

function currentMediaKey() {
  const declared = root?.dataset.mediaType;
  if (MEDIA_TYPES[declared]) return declared;

  const path = location.pathname.replace(/\/+/g, "/").toLowerCase();
  if (path.startsWith("/books/")) return "book";
  if (path.startsWith("/shows/")) return "tv";
  return "movie";
}

const MEDIA = MEDIA_TYPES[currentMediaKey()] ?? MEDIA_TYPES.movie;

const state = {
  session: null,
  profile: null,
  authMode: "login", // "login" | "signup"
  showAuth: false, // logged out: false = public rankings, true = login form
  dashboardTab: "all",
  dashboardData: null,
  addFlow: null,
  rankFlow: null,
};

let sb = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function uid() {
  return state.session?.user?.id ?? null;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setView(html) {
  root.innerHTML = html;
}

function loadingView(message = "Loading…") {
  setView(`<div class="notice">${esc(message)}</div>`);
}

function errorHtml(message) {
  return `<div class="movies-error">${esc(message)}</div>`;
}

function showErrorIn(container, message) {
  const box = document.createElement("div");
  box.className = "movies-error";
  box.textContent = message;
  container.prepend(box);
}

function bucketBadge(bucket) {
  return `<span class="bucket-badge bucket-badge--${esc(bucket)}">${esc(bucketLabel(bucket))}</span>`;
}

function scorePill(score, bucket) {
  return `<span class="score-pill score-pill--${esc(bucket)}">${esc(formatScore(score))}</span>`;
}

function rankPill(rank, bucket) {
  return `<span class="score-pill score-pill--${esc(bucket)}">#${esc(rank)}</span>`;
}

function movieLabel(movie) {
  const year = movie.release_year ? ` (${movie.release_year})` : "";
  return `${movie.title}${year}`;
}

/* ------------------------------------------------------------------ */
/* TMDB movie lookup (optional — needs TMDB_API_KEY in movies-config)  */
/* ------------------------------------------------------------------ */

function tmdbConfigured() {
  return typeof TMDB_API_KEY === "string" && TMDB_API_KEY.trim().length > 0;
}

async function tmdbFetch(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers = { accept: "application/json" };
  if (TMDB_API_KEY.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${TMDB_API_KEY}`; // v4 read access token
  } else {
    url.searchParams.set("api_key", TMDB_API_KEY); // v3 key
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Movie search failed (TMDB ${res.status})`);
  return res.json();
}

async function tmdbSearchMovies(query) {
  const data = await tmdbFetch("/search/movie", { query, include_adult: "false" });
  return (data.results ?? []).slice(0, 8).map((r) => ({
    tmdb_id: r.id,
    title: r.title,
    release_year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
  }));
}

async function tmdbFetchDetails(tmdbId) {
  try {
    const data = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: "credits" });
    return {
      director: (data.credits?.crew ?? []).find((c) => c.job === "Director")?.name ?? null,
      imdb_id: data.imdb_id ?? null,
    };
  } catch {
    return { director: null, imdb_id: null }; // nice-to-have; never block the flow
  }
}

/* ------------------------------------------------------------------ */
/* Per-medium search: TMDB for movies and TV, Open Library for books   */
/* ------------------------------------------------------------------ */

function searchConfigured() {
  return MEDIA.key === "book" ? true : tmdbConfigured(); // Open Library needs no key
}

function normalizedIsbn(query) {
  const compact = query.toUpperCase().replace(/[^0-9X]/g, "");
  return /^(\d{9}[\dX]|\d{13})$/.test(compact) ? compact : null;
}

async function searchMedia(query) {
  if (MEDIA.key === "book") {
    const isbn = normalizedIsbn(query);
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set(isbn ? "isbn" : "q", isbn ?? query);
    url.searchParams.set("limit", "8");
    url.searchParams.set("fields", "key,title,first_publish_year,cover_i,author_name,isbn");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Book search failed (Open Library ${res.status})`);
    const data = await res.json();
    return (data.docs ?? []).map((d) => ({
      isbn: isbn && (d.isbn ?? []).includes(isbn) ? isbn : d.isbn?.[0] ?? null,
      openlibrary_id: d.key,
      title: d.title,
      release_year: d.first_publish_year ?? null,
      poster_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      director: d.author_name?.[0] ?? null,
    }));
  }

  if (MEDIA.key === "tv") {
    const data = await tmdbFetch("/search/tv", { query, include_adult: "false" });
    return (data.results ?? []).slice(0, 8).map((r) => ({
      tmdb_id: r.id,
      title: r.name,
      release_year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
      poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
    }));
  }

  return tmdbSearchMovies(query);
}

/* Extra metadata fetched when a search result is selected. */
async function fetchMediaDetails(item) {
  if (MEDIA.key === "book") return {}; // search results already carry the author
  if (MEDIA.key === "tv") {
    try {
      const data = await tmdbFetch(`/tv/${item.tmdb_id}`, { append_to_response: "external_ids" });
      return {
        director: data.created_by?.[0]?.name ?? null,
        imdb_id: data.external_ids?.imdb_id ?? null,
      };
    } catch {
      return {};
    }
  }
  return tmdbFetchDetails(item.tmdb_id);
}

/* ------------------------------------------------------------------ */
/* OMDb external ratings (optional — needs OMDB_API_KEY in config)     */
/* Provides the IMDb rating and the Rotten Tomatoes critics score.     */
/* ------------------------------------------------------------------ */

function omdbConfigured() {
  return typeof OMDB_API_KEY === "string" && OMDB_API_KEY.trim().length > 0 && !!MEDIA.omdbType;
}

const omdbCache = new Map();

async function fetchExternalRatings({ imdb_id, title, release_year }) {
  if (!omdbConfigured()) return null;

  const cacheKey = imdb_id || `${title}|${release_year ?? ""}`;
  if (omdbCache.has(cacheKey)) return omdbCache.get(cacheKey);

  let result = null;
  try {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", OMDB_API_KEY.trim());
    if (imdb_id) {
      url.searchParams.set("i", imdb_id);
    } else {
      url.searchParams.set("t", title);
      url.searchParams.set("type", MEDIA.omdbType);
      if (release_year) url.searchParams.set("y", String(release_year));
    }
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.Response !== "False") {
        const imdb = data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null;
        const rt = (data.Ratings ?? []).find((r) => r.Source === "Rotten Tomatoes")?.Value ?? null;
        if (imdb || rt) result = { imdb, rt };
      }
    }
  } catch {
    // External ratings are decoration; never surface an error for them.
  }

  omdbCache.set(cacheKey, result);
  return result;
}

function extRatingsText(ratings) {
  if (!ratings) return "";
  const parts = [];
  if (ratings.imdb) parts.push(`IMDb ${ratings.imdb}/10`);
  if (ratings.rt) parts.push(`Rotten Tomatoes ${ratings.rt}`);
  return parts.join(" · ");
}

function missingColumnName(error) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  return text.match(/'([^']+)' column/)?.[1] ?? text.match(/column "([^"]+)"/)?.[1] ?? null;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return { name: "dashboard" };
  if (parts[0] === "add") return { name: "add" };
  if (parts[0] === "rank") return { name: "rank" };
  if (parts[0] === "friends") return { name: "friends" };
  if (parts[0] === "movie" && parts[1]) return { name: "movie", id: parts[1] };
  if (parts[0] === "profile" && parts[1]) return { name: "profile", username: decodeURIComponent(parts[1]) };
  return { name: "dashboard" };
}

function go(hash) {
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

function publicProfileConfigured() {
  return typeof PUBLIC_PROFILE_USERNAME === "string" && PUBLIC_PROFILE_USERNAME.trim().length > 0;
}

async function render() {
  if (!state.session) {
    if (publicProfileConfigured() && !state.showAuth) {
      renderPublicDashboard();
    } else {
      renderAuth();
    }
    return;
  }

  if (!state.profile) {
    loadingView();
    const { data } = await sb.from("profiles").select("*").eq("id", uid()).maybeSingle();
    state.profile = data ?? null;
    if (!state.profile) {
      renderProfileSetup();
      return;
    }
  }

  const route = parseRoute();
  if (route.name === "add") return renderAddFlow();
  if (route.name === "rank") return renderRankFlow();
  if (route.name === "movie") return renderMovieDetail(route.id);
  if (route.name === "friends") return renderFriends();
  if (route.name === "profile") return renderProfilePage(route.username);
  return renderDashboard();
}

/* ------------------------------------------------------------------ */
/* Public (logged-out) rankings                                        */
/* ------------------------------------------------------------------ */

async function renderPublicDashboard() {
  loadingView();

  const { data, error } = await sb.from("public_rankings")
    .select("*")
    .eq("username", PUBLIC_PROFILE_USERNAME.trim())
    .eq("media_type", MEDIA.key)
    .order("rank_position");

  const showLoginButton = `
    <p class="movies-tagline">A ranking app for friends</p>
    <div class="movies-toolbar">
      <button type="button" class="btn" id="show-login">Log in / Sign up</button>
    </div>
  `;

  if (error || !data || data.length === 0) {
    setView(`
      ${showLoginButton}
      <div class="notice">
        ${error
          ? "Public rankings are not available. (Has migration 005 been run in Supabase?)"
          : "No public rankings to show yet."}
      </div>
    `);
    bindShowLogin();
    return;
  }

  const displayName = data[0].display_name;
  const offsets = bucketOffsets(data);

  setView(`
    ${showLoginButton}
    <h2>${esc(displayName)}'s ${esc(MEDIA.plural)}</h2>
    ${BUCKETS.map((b) => {
      const list = data.filter((r) => r.bucket === b).sort((x, y) => x.rank_position - y.rank_position);
      return `
        <div class="movies-section">
          <h3>${bucketBadge(b)}</h3>
          ${list.length === 0 ? `<div class="notice">Nothing here yet.</div>` : list.map((r) => `
            <div class="movie-row movie-row--${esc(r.bucket)}">
              <span class="movie-row__rank">${overallRank(r, offsets)}.</span>
              ${scorePill(r.score, r.bucket)}
              <div class="movie-row__body">
                <span class="movie-row__title">${esc(r.title)}</span>
                ${r.release_year ? `<span class="movie-row__year">(${esc(r.release_year)})</span>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }).join("")}
    <p class="movies-muted">A ranking app for friends &mdash; log in to rank your own</p>
  `);
  bindShowLogin();
}

function bindShowLogin() {
  root.querySelector("#show-login")?.addEventListener("click", () => {
    state.showAuth = true;
    renderAuth();
  });
}

/* ------------------------------------------------------------------ */
/* Auth + profile setup                                                */
/* ------------------------------------------------------------------ */

function renderAuth() {
  const isSignup = state.authMode === "signup";
  setView(`
    <p class="movies-tagline">A ranking app for friends</p>
    <div class="movies-form">
      <form id="auth-form">
        <label for="auth-email">Email</label>
        <input type="email" id="auth-email" required autocomplete="email">
        <label for="auth-password">Password</label>
        <input type="password" id="auth-password" required minlength="8"
               autocomplete="${isSignup ? "new-password" : "current-password"}">
        <div class="movies-form__actions">
          <button type="submit" class="btn">${isSignup ? "Sign up" : "Log in"}</button>
          <button type="button" class="btn btn--inverse" id="auth-toggle">
            ${isSignup ? "I already have an account" : "Create an account"}
          </button>
          ${publicProfileConfigured() ? `<button type="button" class="btn btn--inverse" id="auth-back">Back to rankings</button>` : ""}
        </div>
      </form>
      ${isSignup ? `<p class="movies-muted">You will need an invite code from an existing member to finish setting up your account.</p>` : ""}
    </div>
  `);

  root.querySelector("#auth-toggle").addEventListener("click", () => {
    state.authMode = isSignup ? "login" : "signup";
    renderAuth();
  });

  root.querySelector("#auth-back")?.addEventListener("click", () => {
    state.showAuth = false;
    render();
  });

  root.querySelector("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = root.querySelector("#auth-email").value.trim();
    const password = root.querySelector("#auth-password").value;
    const form = e.target;
    form.querySelector("button[type=submit]").disabled = true;

    try {
      if (isSignup) {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setView(`<div class="notice">Account created. Check your email to confirm your address, then come back and log in.</div>
                   <p><a class="btn" href="#/" id="back-to-login">Back to log in</a></p>`);
          root.querySelector("#back-to-login").addEventListener("click", () => {
            state.authMode = "login";
            renderAuth();
          });
          return;
        }
        // Session is set; onAuthStateChange re-renders into profile setup.
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      form.querySelector("button[type=submit]").disabled = false;
      showErrorIn(root, err.message || "Something went wrong.");
    }
  });
}

function renderProfileSetup() {
  setView(`
    <p>Welcome! One last step: enter your invite code and pick a username.</p>
    <div class="movies-form">
      <form id="setup-form">
        <label for="setup-code">Invite code</label>
        <input type="text" id="setup-code" required autocomplete="off">
        <label for="setup-username">Username</label>
        <input type="text" id="setup-username" required pattern="[A-Za-z0-9_]{3,20}"
               title="3-20 characters: letters, numbers, or underscore">
        <label for="setup-display">Display name</label>
        <input type="text" id="setup-display" required maxlength="60">
        <div class="movies-form__actions">
          <button type="submit" class="btn">Create profile</button>
          <button type="button" class="btn btn--inverse" id="setup-logout">Log out</button>
        </div>
      </form>
    </div>
  `);

  root.querySelector("#setup-logout").addEventListener("click", () => sb.auth.signOut());

  root.querySelector("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    const { error } = await sb.rpc("claim_invite_and_create_profile", {
      p_code: root.querySelector("#setup-code").value.trim(),
      p_username: root.querySelector("#setup-username").value.trim(),
      p_display_name: root.querySelector("#setup-display").value.trim(),
    });
    if (error) {
      btn.disabled = false;
      showErrorIn(root, error.message);
      return;
    }
    state.profile = null;
    go("#/");
    render();
  });
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

function toolbarHtml() {
  return `
    <p class="movies-tagline">A ranking app for friends</p>
    <div class="movies-toolbar">
      <a class="btn" href="#/add">+ Add ${esc(MEDIA.noun)}</a>
      <a class="btn btn--inverse" href="#/">My ${esc(MEDIA.plural)}</a>
      <a class="btn btn--inverse" href="#/friends">Friends</a>
      <button class="btn btn--inverse" id="logout-btn" type="button">Log out</button>
      <span class="movies-muted">Signed in as ${esc(state.profile.display_name)} (@${esc(state.profile.username)})</span>
    </div>
  `;
}

function bindToolbar() {
  root.querySelector("#logout-btn")?.addEventListener("click", () => sb.auth.signOut());
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function loadDashboardData() {
  const [ratingsRes, watchesRes, feedRes] = await Promise.all([
    sb.from("ratings")
      .select("movie_id, bucket, rank_position, score, movies!inner(id, title, release_year, media_type)")
      .eq("user_id", uid())
      .eq("media_type", MEDIA.key)
      .eq("movies.media_type", MEDIA.key)
      .order("rank_position"),
    sb.from("watch_events")
      .select("id, movie_id, watched_on, created_at, movies!inner(title, release_year, media_type), watch_event_participants(profiles(username, display_name))")
      .eq("user_id", uid())
      .eq("movies.media_type", MEDIA.key)
      .order("watched_on", { ascending: false, nullsFirst: false })
      .limit(200),
    sb.from("watch_events_feed")
      .select("id, movie_id, user_id, watched_on, created_at")
      .neq("user_id", uid())
      .eq("media_type", MEDIA.key)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  for (const res of [ratingsRes, watchesRes, feedRes]) {
    if (res.error) throw res.error;
  }

  // The feed is a view, so join movie titles and profile names client-side.
  const feed = feedRes.data ?? [];
  let feedMovies = new Map();
  let feedProfiles = new Map();
  if (feed.length > 0) {
    const movieIds = [...new Set(feed.map((f) => f.movie_id))];
    const userIds = [...new Set(feed.map((f) => f.user_id))];
    const [moviesRes, profilesRes] = await Promise.all([
      sb.from("movies").select("id, title, release_year").eq("media_type", MEDIA.key).in("id", movieIds),
      sb.from("profiles").select("id, username, display_name").in("id", userIds),
    ]);
    feedMovies = new Map((moviesRes.data ?? []).map((m) => [m.id, m]));
    feedProfiles = new Map((profilesRes.data ?? []).map((p) => [p.id, p]));
  }

  return { ratings: ratingsRes.data ?? [], watches: watchesRes.data ?? [], feed, feedMovies, feedProfiles };
}

function watchInfoByMovie(watches) {
  const info = new Map();
  for (const w of watches) {
    const entry = info.get(w.movie_id) ?? { lastWatched: null, withNames: new Set() };
    if (w.watched_on && (!entry.lastWatched || w.watched_on > entry.lastWatched)) {
      entry.lastWatched = w.watched_on;
    }
    for (const p of w.watch_event_participants ?? []) {
      if (p.profiles) entry.withNames.add(p.profiles.display_name);
    }
    info.set(w.movie_id, entry);
  }
  return info;
}

function rankedRowHtml(rating, watchInfo, offsets) {
  const movie = rating.movies;
  const info = watchInfo.get(rating.movie_id);
  const metaParts = [rating.bucket[0].toUpperCase() + rating.bucket.slice(1)];
  if (info?.lastWatched) metaParts.push(`${cap(MEDIA.verbPast)} ${fmtDate(info.lastWatched)}`);
  if (info && info.withNames.size > 0) metaParts.push(`With ${[...info.withNames].join(", ")}`);

  return `
    <div class="movie-row movie-row--${esc(rating.bucket)}">
      <span class="movie-row__rank">${overallRank(rating, offsets)}.</span>
      ${scorePill(rating.score, rating.bucket)}
      <div class="movie-row__body">
        <a class="movie-row__title" href="#/movie/${esc(rating.movie_id)}">${esc(movie?.title ?? "Unknown")}</a>
        ${movie?.release_year ? `<span class="movie-row__year">(${esc(movie.release_year)})</span>` : ""}
        <div class="movie-row__meta">${esc(metaParts.join(" · "))}</div>
      </div>
    </div>
  `;
}

function bucketListHtml(ratings, bucket, watchInfo, offsets) {
  const list = ratings.filter((r) => r.bucket === bucket).sort((a, b) => a.rank_position - b.rank_position);
  if (list.length === 0) {
    return `<div class="notice">No ${esc(bucket)} ${esc(MEDIA.plural)} yet.</div>`;
  }
  return list.map((r) => rankedRowHtml(r, watchInfo, offsets)).join("");
}

function dashboardListHtml(data) {
  const watchInfo = watchInfoByMovie(data.watches);
  const offsets = bucketOffsets(data.ratings);
  if (data.ratings.length === 0 && state.dashboardTab === "all") {
    return `<div class="notice">You have not ranked any ${esc(MEDIA.plural)} yet. Use "Add ${esc(MEDIA.noun)}" to get started.</div>`;
  }
  if (state.dashboardTab === "all") {
    return BUCKETS.map((b) => `
      <h3>${bucketBadge(b)}</h3>
      ${bucketListHtml(data.ratings, b, watchInfo, offsets)}
    `).join("");
  }
  return bucketListHtml(data.ratings, state.dashboardTab, watchInfo, offsets);
}

async function renderDashboard() {
  loadingView();
  let data;
  try {
    data = await loadDashboardData();
  } catch (err) {
    setView(errorHtml(`Could not load your ${MEDIA.plural}: ${err.message}`));
    return;
  }
  state.dashboardData = data;

  const recentWatches = data.watches.slice(0, 8);

  setView(`
    ${toolbarHtml()}

    <div class="movies-section">
      <h2>My ${esc(MEDIA.plural)}</h2>
      <div class="bucket-tabs" role="tablist">
        ${["all", ...BUCKETS].map((tab) => `
          <button type="button" role="tab" data-tab="${tab}" aria-selected="${state.dashboardTab === tab}">
            ${tab === "all" ? "All" : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        `).join("")}
      </div>
      <div id="ranked-lists">${dashboardListHtml(data)}</div>
    </div>

    <div class="movies-section">
      <h2>Recently ${esc(MEDIA.verbPast)}</h2>
      ${recentWatches.length === 0
        ? `<div class="notice">No ${esc(MEDIA.eventPlural)} logged yet.</div>`
        : recentWatches.map((w) => {
            const withNames = (w.watch_event_participants ?? [])
              .map((p) => p.profiles?.display_name)
              .filter(Boolean);
            const meta = [w.watched_on ? fmtDate(w.watched_on) : "date unknown"];
            if (withNames.length > 0) meta.push(`With ${withNames.join(", ")}`);
            return `
              <div class="movie-row">
                <div class="movie-row__body">
                  <a class="movie-row__title" href="#/movie/${esc(w.movie_id)}">${esc(w.movies?.title ?? "Unknown")}</a>
                  ${w.movies?.release_year ? `<span class="movie-row__year">(${esc(w.movies.release_year)})</span>` : ""}
                  <div class="movie-row__meta">${esc(meta.join(" · "))}</div>
                </div>
              </div>
            `;
          }).join("")}
    </div>

    <div class="movies-section">
      <h2>Friend activity</h2>
      ${data.feed.length === 0
        ? `<div class="notice">No friend activity yet. Add friends on the <a href="#/friends">Friends</a> page.</div>`
        : data.feed.map((f) => {
            const movie = data.feedMovies.get(f.movie_id);
            const person = data.feedProfiles.get(f.user_id);
            return `
              <div class="movie-row">
                <div class="movie-row__body">
                  <a href="#/profile/${esc(encodeURIComponent(person?.username ?? ""))}">${esc(person?.display_name ?? "Someone")}</a>
                  ${esc(MEDIA.verbPast)}
                  <a class="movie-row__title" href="#/movie/${esc(f.movie_id)}">${esc(movie?.title ?? `a ${MEDIA.noun}`)}</a>
                  ${movie?.release_year ? `<span class="movie-row__year">(${esc(movie.release_year)})</span>` : ""}
                  <div class="movie-row__meta">${esc(f.watched_on ? fmtDate(f.watched_on) : fmtDate(f.created_at?.slice(0, 10)))}</div>
                </div>
              </div>
            `;
          }).join("")}
    </div>
  `);

  bindToolbar();
  root.querySelectorAll(".bucket-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.dashboardTab = btn.dataset.tab;
      root.querySelectorAll(".bucket-tabs button").forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn)));
      root.querySelector("#ranked-lists").innerHTML = dashboardListHtml(state.dashboardData);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Add-movie flow                                                      */
/* ------------------------------------------------------------------ */

function newAddFlow() {
  return {
    step: "movie",
    mode: searchConfigured() ? "search" : "manual",
    searchQuery: "",
    title: "",
    year: "",
    matches: null,
    selectedMovie: null, // { id | null, tmdb_id?, title, release_year, poster_url?, director? }
    watchedOn: todayStr(),
    withUsers: [], // [{ id, username, display_name }]
    notes: "",
  };
}

async function renderAddFlow() {
  if (!state.addFlow) state.addFlow = newAddFlow();
  const flow = state.addFlow;

  if (flow.step === "movie") return renderAddStepMovie();
  if (flow.step === "details") return renderAddStepDetails();
  return renderAddStepMovie();
}

function renderAddStepMovie() {
  const flow = state.addFlow;
  if (searchConfigured() && flow.mode === "search") {
    renderAddStepSearch();
    return;
  }

  setView(`
    ${toolbarHtml()}
    <h2>Add a ${esc(MEDIA.noun)}</h2>
    <div class="movies-form">
      <form id="movie-form">
        <label for="movie-title">Title</label>
        <input type="text" id="movie-title" required value="${esc(flow.title)}">
        <label for="movie-year">${esc(MEDIA.yearLabel)}</label>
        <input type="number" id="movie-year" min="1000" max="2100" value="${esc(flow.year)}">
        <div class="movies-form__actions">
          <button type="submit" class="btn">Continue</button>
          ${searchConfigured() ? `<button type="button" class="btn btn--inverse" id="switch-to-search">Search instead</button>` : ""}
          <a class="btn btn--inverse" href="#/">Cancel</a>
        </div>
      </form>
      <div id="movie-matches">
        ${flow.matches === null ? "" : matchesHtml(flow.matches)}
      </div>
    </div>
  `);
  bindToolbar();

  root.querySelector("#switch-to-search")?.addEventListener("click", () => {
    flow.mode = "search";
    flow.matches = null;
    renderAddStepMovie();
  });

  root.querySelector("#movie-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    flow.title = root.querySelector("#movie-title").value.trim();
    flow.year = root.querySelector("#movie-year").value.trim();
    if (!flow.title) return;

    // Check for existing entries with a similar title so the same item is
    // not added twice under slightly different spellings.
    const { data, error } = await sb.from("movies")
      .select("id, title, release_year")
      .eq("media_type", MEDIA.key)
      .ilike("title", `%${flow.title}%`)
      .limit(8);
    if (error) {
      showErrorIn(root, error.message);
      return;
    }

    if ((data ?? []).length === 0) {
      flow.selectedMovie = { id: null, title: flow.title, release_year: flow.year ? Number(flow.year) : null };
      flow.step = "details";
      renderAddFlow();
      return;
    }

    flow.matches = data;
    renderAddStepMovie();
  });

  if (flow.matches !== null) bindMatchButtons();
}

function renderAddStepSearch() {
  const flow = state.addFlow;
  setView(`
    ${toolbarHtml()}
    <h2>Add a ${esc(MEDIA.noun)}</h2>
    <div class="movies-form">
      <label for="tmdb-search">Search for a ${esc(MEDIA.noun)}</label>
      <input type="text" id="tmdb-search" placeholder="${esc(MEDIA.searchPlaceholder)}" autocomplete="off" value="${esc(flow.searchQuery)}">
      <ul class="movies-search-results" id="tmdb-results"></ul>
      <p class="movies-muted">
        Can't find it?
        <button type="button" class="btn btn--inverse btn--small-inline" id="switch-to-manual">Add it manually</button>
      </p>
      <p><a class="btn btn--inverse" href="#/">Cancel</a></p>
      <p class="movies-muted">${MEDIA.searchAttribution}</p>
    </div>
  `);
  bindToolbar();

  root.querySelector("#switch-to-manual").addEventListener("click", () => {
    flow.mode = "manual";
    renderAddStepMovie();
  });

  const input = root.querySelector("#tmdb-search");
  const results = root.querySelector("#tmdb-results");

  const renderResults = (movies) => {
    results.innerHTML = movies.length === 0
      ? `<li><span class="movies-muted">No results.</span></li>`
      : movies.map((m, i) => `
          <li>
            ${m.poster_url
              ? `<img class="tmdb-thumb" src="${esc(m.poster_url)}" alt="" loading="lazy">`
              : `<span class="tmdb-thumb tmdb-thumb--empty"></span>`}
            <span class="friend-row__name">${esc(m.title)}
              ${m.release_year ? `<span class="movies-muted">(${esc(m.release_year)})</span>` : ""}
              ${m.director ? `<span class="movies-muted">${esc(MEDIA.credit)} ${esc(m.director)}</span>` : ""}
              ${m.isbn ? `<span class="movies-muted">ISBN ${esc(m.isbn)}</span>` : ""}
              <span class="tmdb-ratings movies-muted" data-ext-id="${esc(m.tmdb_id ?? m.openlibrary_id ?? i)}"></span>
            </span>
            <button type="button" class="btn btn--inverse btn--small-inline" data-pick="${i}">Select</button>
          </li>
        `).join("");

    results.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const picked = movies[Number(btn.dataset.pick)];
        btn.disabled = true;
        Object.assign(picked, await fetchMediaDetails(picked));
        flow.selectedMovie = { id: null, ...picked };
        flow.step = "details";
        renderAddFlow();
      });
    });

    // Fill in IMDb / Rotten Tomatoes ratings as OMDb responds. Spans are
    // keyed by TMDB id, so a late response can never label the wrong movie
    // even if the user has typed a new search in the meantime.
    if (omdbConfigured()) {
      for (const m of movies) {
        fetchExternalRatings(m).then((ratings) => {
          const span = results.querySelector(`[data-ext-id="${m.tmdb_id}"]`);
          if (span && ratings) span.textContent = extRatingsText(ratings);
        });
      }
    }
  };

  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    flow.searchQuery = input.value.trim();
    if (flow.searchQuery.length < 2) {
      results.innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      try {
        const movies = await searchMedia(flow.searchQuery);
        renderResults(movies);
      } catch (err) {
        results.innerHTML = `<li><span class="movies-muted">${esc(err.message)} — you can still add the ${esc(MEDIA.noun)} manually.</span></li>`;
      }
    }, 300);
  });

  input.focus();
  if (flow.searchQuery.length >= 2) input.dispatchEvent(new Event("input"));
}

function matchesHtml(matches) {
  return `
    <h3>Is it one of these?</h3>
    <ul class="movies-search-results">
      ${matches.map((m) => `
        <li>
          <span>${esc(movieLabel(m))}</span>
          <button type="button" class="btn btn--inverse btn--small-inline" data-movie-id="${esc(m.id)}">Use this</button>
        </li>
      `).join("")}
    </ul>
    <button type="button" class="btn btn--inverse" id="create-new-movie">No &mdash; add as a new ${esc(MEDIA.noun)}</button>
  `;
}

function bindMatchButtons() {
  const flow = state.addFlow;
  root.querySelectorAll("#movie-matches [data-movie-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      flow.selectedMovie = flow.matches.find((m) => m.id === btn.dataset.movieId);
      flow.step = "details";
      renderAddFlow();
    });
  });
  root.querySelector("#create-new-movie")?.addEventListener("click", () => {
    flow.selectedMovie = { id: null, title: flow.title, release_year: flow.year ? Number(flow.year) : null };
    flow.step = "details";
    renderAddFlow();
  });
}

function renderAddStepDetails() {
  const flow = state.addFlow;
  setView(`
    ${toolbarHtml()}
    <h2>Log this ${esc(MEDIA.noun)}</h2>
    <p><strong>${esc(movieLabel(flow.selectedMovie))}</strong>
       <button type="button" class="btn btn--inverse btn--small-inline" id="change-movie">Change</button></p>
    <div class="movies-form">
      <form id="details-form">
        <label for="watch-date">When did you ${esc(MEDIA.verb)} it?</label>
        <input type="date" id="watch-date" value="${esc(flow.watchedOn)}">

        <label for="with-search">${esc(cap(MEDIA.verbPast))} with (search registered users)</label>
        <div id="with-chips">${withChipsHtml(flow.withUsers)}</div>
        <input type="text" id="with-search" placeholder="Search by name or username" autocomplete="off">
        <ul class="movies-search-results" id="with-results"></ul>

        <label for="watch-notes">Private notes (optional, only you can see these)</label>
        <textarea id="watch-notes" rows="2">${esc(flow.notes)}</textarea>

        <div class="movies-form__actions">
          <button type="submit" class="btn">Save &amp; rate it</button>
          <button type="button" class="btn btn--inverse" id="save-unrated">Save without rating</button>
          <a class="btn btn--inverse" href="#/">Cancel</a>
        </div>
      </form>
    </div>
  `);
  bindToolbar();

  root.querySelector("#change-movie").addEventListener("click", () => {
    flow.step = "movie";
    flow.matches = null;
    renderAddFlow();
  });

  bindWithSearch(flow);

  const submitWatch = async (thenRate) => {
    flow.watchedOn = root.querySelector("#watch-date").value || null;
    flow.notes = root.querySelector("#watch-notes").value.trim();
    try {
      const movieId = await saveWatch(flow);
      state.addFlow = null;
      if (thenRate) {
        startRanking({ id: movieId, title: flow.selectedMovie.title, release_year: flow.selectedMovie.release_year });
      } else {
        go("#/");
      }
    } catch (err) {
      showErrorIn(root, err.message || "Could not save the watch.");
    }
  };

  root.querySelector("#details-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitWatch(true);
  });
  root.querySelector("#save-unrated").addEventListener("click", () => submitWatch(false));
}

function withChipsHtml(users) {
  if (users.length === 0) return `<span class="movies-muted">No one selected.</span>`;
  return users.map((u) => `
    <span class="person-chip">${esc(u.display_name)}
      <button type="button" data-remove-user="${esc(u.id)}" aria-label="Remove">&times;</button>
    </span>
  `).join("");
}

function bindWithSearch(flow) {
  const input = root.querySelector("#with-search");
  const results = root.querySelector("#with-results");
  const chips = root.querySelector("#with-chips");

  const refreshChips = () => {
    chips.innerHTML = withChipsHtml(flow.withUsers);
    chips.querySelectorAll("[data-remove-user]").forEach((btn) => {
      btn.addEventListener("click", () => {
        flow.withUsers = flow.withUsers.filter((u) => u.id !== btn.dataset.removeUser);
        refreshChips();
      });
    });
  };
  refreshChips();

  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      const { data } = await sb.from("profiles")
        .select("id, username, display_name")
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .neq("id", uid())
        .limit(6);
      results.innerHTML = (data ?? [])
        .filter((p) => !flow.withUsers.some((u) => u.id === p.id))
        .map((p) => `
          <li>
            <span>${esc(p.display_name)} <span class="movies-muted">@${esc(p.username)}</span></span>
            <button type="button" class="btn btn--inverse btn--small-inline" data-add-user="${esc(p.id)}">Add</button>
          </li>
        `).join("");
      results.querySelectorAll("[data-add-user]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const person = (data ?? []).find((p) => p.id === btn.dataset.addUser);
          if (person) flow.withUsers.push(person);
          input.value = "";
          results.innerHTML = "";
          refreshChips();
        });
      });
    }, 250);
  });
}

async function saveWatch(flow) {
  const sel = flow.selectedMovie;
  let movieId = sel.id;

  // A search pick may already exist in our catalog (added by a friend):
  // reuse it instead of creating a duplicate.
  const findExisting = async () => {
    let q = sb.from("movies").select("id").eq("media_type", MEDIA.key);
    if (sel.tmdb_id) q = q.eq("tmdb_id", sel.tmdb_id);
    else if (sel.openlibrary_id) q = q.eq("openlibrary_id", sel.openlibrary_id);
    else return null;
    const { data } = await q.maybeSingle();
    return data?.id ?? null;
  };

  if (!movieId) movieId = await findExisting();

  if (!movieId) {
    const insertPayload = {
      media_type: MEDIA.key,
      title: sel.title,
      release_year: sel.release_year ?? null,
      tmdb_id: sel.tmdb_id ?? null,
      imdb_id: sel.imdb_id ?? null,
      openlibrary_id: sel.openlibrary_id ?? null,
      poster_url: sel.poster_url ?? null,
      director: sel.director ?? null,
    };
    let { data, error } = await sb.from("movies")
      .insert(insertPayload)
      .select("id")
      .single();

    const missingColumn = missingColumnName(error);
    if (missingColumn && ["imdb_id"].includes(missingColumn)) {
      const fallbackPayload = { ...insertPayload };
      delete fallbackPayload[missingColumn];
      ({ data, error } = await sb.from("movies")
        .insert(fallbackPayload)
        .select("id")
        .single());
    }

    if (error) {
      // Unique violation: someone added it between our check and insert.
      // Fall back to the existing row.
      if (error.code === "23505") {
        movieId = await findExisting();
        if (!movieId) throw error;
      } else {
        throw error;
      }
    } else {
      movieId = data.id;
    }
  }

  const { data: watchData, error: watchError } = await sb.from("watch_events")
    .insert({
      movie_id: movieId,
      user_id: uid(),
      watched_on: flow.watchedOn,
      notes: flow.notes || null,
    })
    .select("id")
    .single();
  if (watchError) throw watchError;

  if (flow.withUsers.length > 0) {
    const { error: partError } = await sb.from("watch_event_participants").insert(
      flow.withUsers.map((u) => ({
        watch_event_id: watchData.id,
        participant_user_id: u.id,
      }))
    );
    if (partError) throw partError;
  }

  return movieId;
}

/* ------------------------------------------------------------------ */
/* Ranking flow (bucket choice + pairwise comparisons)                 */
/* ------------------------------------------------------------------ */

function startRanking(movie) {
  state.rankFlow = { movie, step: "bucket", bucket: null, list: [], insertion: null };
  go("#/rank");
}

async function renderRankFlow() {
  const flow = state.rankFlow;
  if (!flow) {
    // e.g. the page was refreshed mid-flow: no rating has been created yet,
    // so just return to the dashboard (spec 18, option 1).
    go("#/");
    return;
  }

  if (flow.step === "bucket") return renderBucketChoice();
  if (flow.step === "compare") return renderComparison();
  if (flow.step === "done") return renderRankDone();
}

function renderBucketChoice() {
  const flow = state.rankFlow;
  setView(`
    ${toolbarHtml()}
    <h2>How was ${esc(movieLabel(flow.movie))}?</h2>
    <div class="bucket-picker">
      ${BUCKETS.map((b) => `
        <button type="button" class="bucket-picker__${b}" data-bucket="${b}">
          ${bucketBadge(b)}
        </button>
      `).join("")}
    </div>
    <p><a class="btn btn--inverse" href="#/">Cancel</a></p>
    <p class="movies-muted">Cancelling keeps the ${esc(MEDIA.verb)} logged; you can rate the ${esc(MEDIA.noun)} later from its page.</p>
  `);
  bindToolbar();

  root.querySelectorAll("[data-bucket]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bucket = btn.dataset.bucket;
      try {
        await chooseBucket(bucket);
      } catch (err) {
        showErrorIn(root, err.message || "Could not load your rankings.");
      }
    });
  });
}

async function chooseBucket(bucket) {
  const flow = state.rankFlow;
  flow.bucket = bucket;

  const { data, error } = await sb.from("ratings")
    .select("movie_id, rank_position, movies!inner(id, title, release_year, media_type)")
    .eq("user_id", uid())
    .eq("media_type", MEDIA.key)
    .eq("movies.media_type", MEDIA.key)
    .eq("bucket", bucket)
    .neq("movie_id", flow.movie.id)
    .order("rank_position");
  if (error) throw error;

  flow.list = data ?? [];

  if (flow.list.length === 0) {
    await finalizeRanking(0);
    return;
  }

  flow.insertion = createInsertionState(flow.list.length);
  flow.step = "compare";
  renderRankFlow();
}

function renderComparison() {
  const flow = state.rankFlow;
  const idx = nextComparisonIndex(flow.insertion);
  const existing = flow.list[idx].movies;

  setView(`
    ${toolbarHtml()}
    <h2>Which ${esc(MEDIA.noun)} did you like more?</h2>
    <div class="compare-cards">
      <div class="compare-card">
        <div class="compare-card__title">${esc(movieLabel(flow.movie))}</div>
        <div class="movies-muted">The ${esc(MEDIA.noun)} you're ranking</div>
        <button type="button" class="btn" id="prefer-new">I liked this more</button>
      </div>
      <div class="compare-vs">vs.</div>
      <div class="compare-card">
        <div class="compare-card__title">${esc(movieLabel(existing))}</div>
        <div class="movies-muted">Already in your ${esc(flow.bucket)} list</div>
        <button type="button" class="btn" id="prefer-existing">I liked this more</button>
      </div>
    </div>
    <p>
      <button type="button" class="btn btn--inverse" id="change-bucket">Change bucket</button>
      <a class="btn btn--inverse" href="#/">Cancel</a>
    </p>
  `);
  bindToolbar();

  const record = async (prefersNew) => {
    // Comparison history is for debugging/analysis only; a failure here
    // should not block ranking.
    sb.from("pairwise_comparisons").insert({
      user_id: uid(),
      new_movie_id: flow.movie.id,
      compared_movie_id: existing.id,
      preferred_movie_id: prefersNew ? flow.movie.id : existing.id,
      bucket: flow.bucket,
    }).then(({ error }) => {
      if (error) console.warn("Could not log comparison:", error.message);
    });

    flow.insertion = applyComparison(flow.insertion, prefersNew);
    if (isInsertionDone(flow.insertion)) {
      loadingView("Saving your ranking…");
      try {
        await finalizeRanking(flow.insertion.low);
      } catch (err) {
        setView(`
          ${toolbarHtml()}
          ${errorHtml(err.message || "Could not save the ranking.")}
          <p><a class="btn" href="#/movie/${esc(flow.movie.id)}">Back to the ${esc(MEDIA.noun)}</a></p>
        `);
        bindToolbar();
        state.rankFlow = null;
      }
    } else {
      renderComparison();
    }
  };

  root.querySelector("#prefer-new").addEventListener("click", () => record(true));
  root.querySelector("#prefer-existing").addEventListener("click", () => record(false));
  root.querySelector("#change-bucket").addEventListener("click", () => {
    flow.step = "bucket";
    flow.insertion = null;
    renderRankFlow();
  });
}

async function finalizeRanking(insertionIndex) {
  const flow = state.rankFlow;
  const orderedIds = insertAt(flow.list.map((r) => r.movie_id), insertionIndex, flow.movie.id);

  const { error } = await sb.rpc("rank_movie", {
    p_movie_id: flow.movie.id,
    p_bucket: flow.bucket,
    p_ordered_movie_ids: orderedIds,
  });
  if (error) throw error;

  const [{ data }, { data: allMine }] = await Promise.all([
    sb.from("ratings")
      .select("rank_position, score, bucket")
      .eq("user_id", uid())
      .eq("movie_id", flow.movie.id)
      .single(),
    sb.from("ratings").select("bucket").eq("user_id", uid()).eq("media_type", MEDIA.key),
  ]);

  flow.result = data;
  flow.overallRank = overallRank(data, bucketOffsets(allMine ?? []));
  flow.step = "done";
  renderRankFlow();
}

function renderRankDone() {
  const flow = state.rankFlow;
  const r = flow.result;
  setView(`
    ${toolbarHtml()}
    <h2>Ranked!</h2>
    <div class="notice">
      <strong>${esc(movieLabel(flow.movie))}</strong> is now
      ${bucketBadge(r.bucket)} ${scorePill(r.score, r.bucket)} ${rankPill(flow.overallRank, r.bucket)}
    </div>
    <p>
      <a class="btn" href="#/">Back to my ${esc(MEDIA.plural)}</a>
      <a class="btn btn--inverse" href="#/movie/${esc(flow.movie.id)}">View ${esc(MEDIA.noun)}</a>
    </p>
  `);
  bindToolbar();
  state.rankFlow = null;
}

/* ------------------------------------------------------------------ */
/* Movie detail                                                        */
/* ------------------------------------------------------------------ */

async function renderMovieDetail(movieId) {
  loadingView();

  const [movieRes, ratingRes, allMineRes, watchesRes, othersRes] = await Promise.all([
    sb.from("movies").select("*").eq("id", movieId).eq("media_type", MEDIA.key).maybeSingle(),
    sb.from("ratings")
      .select("bucket, rank_position, score")
      .eq("user_id", uid())
      .eq("movie_id", movieId)
      .eq("media_type", MEDIA.key)
      .maybeSingle(),
    sb.from("ratings").select("bucket").eq("user_id", uid()).eq("media_type", MEDIA.key),
    sb.from("watch_events")
      .select("id, watched_on, notes, created_at, movies!inner(media_type), watch_event_participants(profiles(username, display_name))")
      .eq("user_id", uid())
      .eq("movie_id", movieId)
      .eq("movies.media_type", MEDIA.key)
      .order("watched_on", { ascending: false, nullsFirst: false }),
    sb.from("movie_ratings_visible").select("user_id, bucket, score").eq("movie_id", movieId).neq("user_id", uid()),
  ]);

  const movie = movieRes.data;
  if (!movie) {
    setView(`${errorHtml(`${cap(MEDIA.noun)} not found.`)}<p><a class="btn" href="#/">Back</a></p>`);
    return;
  }

  const myRating = ratingRes.data;
  const myOverallRank = myRating ? overallRank(myRating, bucketOffsets(allMineRes.data ?? [])) : null;
  const watches = watchesRes.data ?? [];

  let otherRatings = othersRes.data;
  if (othersRes.error) {
    // The community-ratings view is missing (migration 002 not run yet):
    // fall back to the base table, which RLS limits to accepted friends.
    const { data } = await sb.from("ratings")
      .select("user_id, bucket, score")
      .eq("movie_id", movieId)
      .neq("user_id", uid());
    otherRatings = data;
  }
  otherRatings = (otherRatings ?? []).sort((a, b) => b.score - a.score);

  let otherProfiles = new Map();
  if (otherRatings.length > 0) {
    const { data } = await sb.from("profiles")
      .select("id, username, display_name")
      .in("id", otherRatings.map((r) => r.user_id));
    otherProfiles = new Map((data ?? []).map((p) => [p.id, p]));
  }

  const allScores = [...otherRatings.map((r) => Number(r.score)), ...(myRating ? [Number(myRating.score)] : [])];
  const avgScore = allScores.length > 0
    ? formatScore(allScores.reduce((a, b) => a + b, 0) / allScores.length)
    : null;

  setView(`
    ${toolbarHtml()}
    <h2>${esc(movie.title)} ${movie.release_year ? `<span class="movie-row__year">(${esc(movie.release_year)})</span>` : ""}</h2>
    ${movie.director ? `<p class="movies-muted">${esc(MEDIA.credit)} ${esc(movie.director)}</p>` : ""}
    <p class="movies-muted" id="ext-ratings" hidden></p>
    ${movie.poster_url ? `<img class="movie-poster" src="${esc(movie.poster_url)}" alt="Poster for ${esc(movie.title)}" loading="lazy">` : ""}

    <div class="movies-section">
      <h3>My rating</h3>
      ${myRating
        ? `<p>${bucketBadge(myRating.bucket)} ${scorePill(myRating.score, myRating.bucket)} ${rankPill(myOverallRank, myRating.bucket)}</p>`
        : `<div class="notice">You have not rated this ${esc(MEDIA.noun)} yet.</div>`}
      <p>
        <button type="button" class="btn" id="rate-btn">${myRating ? "Re-rank / change bucket" : `Rate this ${esc(MEDIA.noun)}`}</button>
        <button type="button" class="btn btn--inverse" id="log-watch-btn">Log another ${esc(MEDIA.verb)}</button>
        ${myRating ? `<button type="button" class="btn btn--inverse" id="delete-rating-btn">Remove rating</button>` : ""}
      </p>
      <div id="log-watch-area"></div>
    </div>

    <div class="movies-section">
      <h3>My ${esc(MEDIA.verb)} history</h3>
      ${watches.length === 0
        ? `<div class="notice">No ${esc(MEDIA.eventPlural)} logged for this ${esc(MEDIA.noun)}.</div>`
        : watches.map((w) => {
            const withNames = (w.watch_event_participants ?? [])
              .map((p) => p.profiles?.display_name).filter(Boolean);
            const meta = [w.watched_on ? fmtDate(w.watched_on) : "date unknown"];
            if (withNames.length > 0) meta.push(`With ${withNames.join(", ")}`);
            return `
              <div class="movie-row">
                <div class="movie-row__body">
                  ${esc(meta.join(" · "))}
                  ${w.notes ? `<div class="movie-row__meta">${esc(w.notes)}</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
    </div>

    <div class="movies-section">
      <h3>What others rated it</h3>
      ${avgScore !== null && allScores.length > 1
        ? `<p class="movies-muted">Average: <strong>${esc(avgScore)}</strong> across ${allScores.length} ratings</p>`
        : ""}
      ${otherRatings.length === 0
        ? `<div class="notice">No one else has rated this ${esc(MEDIA.noun)} yet.</div>`
        : otherRatings.map((r) => {
            const p = otherProfiles.get(r.user_id);
            return `
              <div class="movie-row">
                ${scorePill(r.score, r.bucket)}
                <div class="movie-row__body">
                  <a href="#/profile/${esc(encodeURIComponent(p?.username ?? ""))}">${esc(p?.display_name ?? "Member")}</a>
                  ${bucketBadge(r.bucket)}
                </div>
              </div>
            `;
          }).join("")}
    </div>

    <p><a class="btn btn--inverse" href="#/">Back to my ${esc(MEDIA.plural)}</a></p>
  `);
  bindToolbar();

  // External ratings load after the page renders so a slow (or down) OMDb
  // never delays the movie page itself.
  if (omdbConfigured()) {
    fetchExternalRatings(movie).then((ratings) => {
      const p = root.querySelector("#ext-ratings");
      const text = extRatingsText(ratings);
      if (p && text) {
        p.textContent = text;
        p.hidden = false;
      }
    });
  }

  root.querySelector("#rate-btn").addEventListener("click", () => {
    startRanking({ id: movie.id, title: movie.title, release_year: movie.release_year });
  });

  root.querySelector("#delete-rating-btn")?.addEventListener("click", async () => {
    if (!confirm(`Remove your rating for "${movie.title}"? Your ${MEDIA.verb} history is kept.`)) return;
    const { error } = await sb.rpc("remove_rating", { p_movie_id: movie.id });
    if (error) {
      showErrorIn(root, error.message);
      return;
    }
    renderMovieDetail(movieId);
  });

  root.querySelector("#log-watch-btn").addEventListener("click", () => {
    const area = root.querySelector("#log-watch-area");
    area.innerHTML = `
      <form id="rewatch-form" class="movies-form">
        <label for="rewatch-date">${esc(cap(MEDIA.verbPast))} on</label>
        <input type="date" id="rewatch-date" value="${esc(todayStr())}">
        <label for="rewatch-search">${esc(cap(MEDIA.verbPast))} with</label>
        <div id="with-chips"></div>
        <input type="text" id="with-search" placeholder="Search by name or username" autocomplete="off">
        <ul class="movies-search-results" id="with-results"></ul>
        <label for="rewatch-notes">Private notes (optional)</label>
        <textarea id="rewatch-notes" rows="2"></textarea>
        <div class="movies-form__actions">
          <button type="submit" class="btn">Save ${esc(MEDIA.verb)}</button>
        </div>
      </form>
    `;
    const rewatch = { withUsers: [] };
    bindWithSearch(rewatch);
    area.querySelector("#rewatch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const flow = {
        selectedMovie: { id: movie.id },
        watchedOn: area.querySelector("#rewatch-date").value || null,
        notes: area.querySelector("#rewatch-notes").value.trim(),
        withUsers: rewatch.withUsers,
      };
      try {
        await saveWatch(flow);
        renderMovieDetail(movieId);
      } catch (err) {
        showErrorIn(root, err.message);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Friends page                                                        */
/* ------------------------------------------------------------------ */

async function renderFriends() {
  loadingView();

  const { data: friendships, error } = await sb.from("friendships")
    .select(`
      id, requester_id, addressee_id, status, created_at,
      requester:profiles!friendships_requester_id_fkey(username, display_name),
      addressee:profiles!friendships_addressee_id_fkey(username, display_name)
    `);
  if (error) {
    setView(errorHtml(`Could not load friends: ${error.message}`));
    return;
  }

  const me = uid();
  const incoming = friendships.filter((f) => f.status === "pending" && f.addressee_id === me);
  const outgoing = friendships.filter((f) => f.status === "pending" && f.requester_id === me);
  const accepted = friendships.filter((f) => f.status === "accepted");

  const friendRow = (f) => {
    const other = f.requester_id === me ? f.addressee : f.requester;
    const otherUsername = other?.username ?? "";
    return { other, otherUsername };
  };

  setView(`
    ${toolbarHtml()}
    <h2>Friends</h2>

    <div class="movies-section">
      <h3>Find people</h3>
      <div class="movies-form">
        <input type="text" id="friend-search" placeholder="Search by name or username" autocomplete="off">
        <ul class="movies-search-results" id="friend-search-results"></ul>
      </div>
    </div>

    <div class="movies-section">
      <h3>Incoming requests</h3>
      ${incoming.length === 0 ? `<div class="notice">No incoming requests.</div>` : incoming.map((f) => `
        <div class="friend-row">
          <span class="friend-row__name">
            <a href="#/profile/${esc(encodeURIComponent(f.requester?.username ?? ""))}">${esc(f.requester?.display_name ?? "Unknown")}</a>
            <span class="movies-muted">@${esc(f.requester?.username ?? "")}</span>
          </span>
          <button type="button" class="btn btn--small-inline" data-accept="${esc(f.id)}">Accept</button>
          <button type="button" class="btn btn--inverse btn--small-inline" data-remove="${esc(f.id)}">Decline</button>
        </div>
      `).join("")}
    </div>

    <div class="movies-section">
      <h3>Outgoing requests</h3>
      ${outgoing.length === 0 ? `<div class="notice">No outgoing requests.</div>` : outgoing.map((f) => `
        <div class="friend-row">
          <span class="friend-row__name">
            ${esc(f.addressee?.display_name ?? "Unknown")}
            <span class="movies-muted">@${esc(f.addressee?.username ?? "")}</span>
          </span>
          <button type="button" class="btn btn--inverse btn--small-inline" data-remove="${esc(f.id)}">Cancel</button>
        </div>
      `).join("")}
    </div>

    <div class="movies-section">
      <h3>My friends</h3>
      ${accepted.length === 0 ? `<div class="notice">No friends yet. Search above to send a request.</div>` : accepted.map((f) => {
        const { other, otherUsername } = friendRow(f);
        return `
          <div class="friend-row">
            <span class="friend-row__name">
              <a href="#/profile/${esc(encodeURIComponent(otherUsername))}">${esc(other?.display_name ?? "Unknown")}</a>
              <span class="movies-muted">@${esc(otherUsername)}</span>
            </span>
            <button type="button" class="btn btn--inverse btn--small-inline" data-remove="${esc(f.id)}">Unfriend</button>
          </div>
        `;
      }).join("")}
    </div>

    <div class="movies-section">
      <h3>Invite a friend</h3>
      <p class="movies-muted">Generate a one-time invite code and share it privately. It is needed to sign up.</p>
      <button type="button" class="btn" id="invite-btn">Generate invite code</button>
      <span id="invite-code" class="movies-muted"></span>
    </div>
  `);
  bindToolbar();

  root.querySelectorAll("[data-accept]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { error: err } = await sb.from("friendships").update({ status: "accepted" }).eq("id", btn.dataset.accept);
      if (err) showErrorIn(root, err.message);
      else renderFriends();
    });
  });

  root.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { error: err } = await sb.from("friendships").delete().eq("id", btn.dataset.remove);
      if (err) showErrorIn(root, err.message);
      else renderFriends();
    });
  });

  root.querySelector("#invite-btn").addEventListener("click", async () => {
    const { data, error: err } = await sb.rpc("create_invite_code");
    if (err) {
      showErrorIn(root, err.message);
      return;
    }
    root.querySelector("#invite-code").innerHTML = `Invite code: <code>${esc(data)}</code>`;
  });

  const searchInput = root.querySelector("#friend-search");
  const searchResults = root.querySelector("#friend-search-results");
  let timer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(timer);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchResults.innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      const { data } = await sb.from("profiles")
        .select("id, username, display_name")
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .neq("id", me)
        .limit(8);
      const related = new Set(friendships.flatMap((f) => [f.requester_id, f.addressee_id]));
      searchResults.innerHTML = (data ?? []).map((p) => `
        <li>
          <span>
            <a href="#/profile/${esc(encodeURIComponent(p.username))}">${esc(p.display_name)}</a>
            <span class="movies-muted">@${esc(p.username)}</span>
          </span>
          ${related.has(p.id)
            ? `<span class="movies-muted">Requested or friends</span>`
            : `<button type="button" class="btn btn--inverse btn--small-inline" data-request="${esc(p.id)}">Add friend</button>`}
        </li>
      `).join("");
      searchResults.querySelectorAll("[data-request]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const { error: err } = await sb.from("friendships").insert({
            requester_id: me,
            addressee_id: btn.dataset.request,
            status: "pending",
          });
          if (err) showErrorIn(root, err.message);
          else renderFriends();
        });
      });
    }, 250);
  });
}

/* ------------------------------------------------------------------ */
/* Another user's profile                                              */
/* ------------------------------------------------------------------ */

async function renderProfilePage(username) {
  loadingView();

  const { data: person } = await sb.from("profiles")
    .select("id, username, display_name")
    .eq("username", username)
    .maybeSingle();

  if (!person) {
    setView(`${toolbarHtml()}${errorHtml("User not found.")}<p><a class="btn" href="#/friends">Back to friends</a></p>`);
    bindToolbar();
    return;
  }

  if (person.id === uid()) {
    go("#/");
    return;
  }

  // RLS only returns rows for accepted friends, so an empty result for a
  // non-friend is expected — not an error.
  const { data: ratings } = await sb.from("ratings")
    .select("movie_id, bucket, rank_position, score, movies!inner(id, title, release_year, media_type)")
    .eq("user_id", person.id)
    .eq("media_type", MEDIA.key)
    .eq("movies.media_type", MEDIA.key)
    .order("rank_position");

  const { data: friendship } = await sb.from("friendships")
    .select("id, status, requester_id, addressee_id")
    .or(`and(requester_id.eq.${uid()},addressee_id.eq.${person.id}),and(requester_id.eq.${person.id},addressee_id.eq.${uid()})`)
    .maybeSingle();

  const isFriend = friendship?.status === "accepted";

  setView(`
    ${toolbarHtml()}
    <h2>${esc(person.display_name)} <span class="movies-muted">@${esc(person.username)}</span></h2>

    ${!isFriend ? `
      <div class="notice">
        You can only see rankings of accepted friends.
        ${friendship?.status === "pending" ? "A friend request is pending." : ""}
      </div>
      ${!friendship ? `<p><button type="button" class="btn" id="add-friend-btn">Add friend</button></p>` : ""}
    ` : ""}

    ${isFriend ? BUCKETS.map((b) => {
      const offsets = bucketOffsets(ratings ?? []);
      const list = (ratings ?? []).filter((r) => r.bucket === b).sort((x, y) => x.rank_position - y.rank_position);
      return `
        <div class="movies-section">
          <h3>${bucketBadge(b)}</h3>
          ${list.length === 0 ? `<div class="notice">Nothing here yet.</div>` : list.map((r) => `
            <div class="movie-row">
              <span class="movie-row__rank">${overallRank(r, offsets)}.</span>
              ${scorePill(r.score, r.bucket)}
              <div class="movie-row__body">
                <a class="movie-row__title" href="#/movie/${esc(r.movie_id)}">${esc(r.movies?.title ?? "Unknown")}</a>
                ${r.movies?.release_year ? `<span class="movie-row__year">(${esc(r.movies.release_year)})</span>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }).join("") : ""}

    <p><a class="btn btn--inverse" href="#/friends">Back to friends</a></p>
  `);
  bindToolbar();

  root.querySelector("#add-friend-btn")?.addEventListener("click", async () => {
    const { error } = await sb.from("friendships").insert({
      requester_id: uid(),
      addressee_id: person.id,
      status: "pending",
    });
    if (error) showErrorIn(root, error.message);
    else renderProfilePage(username);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  if (!root) return;

  if (SUPABASE_URL.includes("YOUR-PROJECT") || SUPABASE_ANON_KEY.includes("YOUR-SUPABASE")) {
    setView(`
      <div class="notice">
        <strong>MovieRank is not configured yet.</strong><br>
        Set your Supabase URL and anon key in <code>assets/js/movies-config.js</code>
        and run <code>supabase/schema.sql</code> in your Supabase project.
        See <code>supabase/README.md</code> for the full setup steps.
      </div>
    `);
    return;
  }

  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  sb.auth.getSession().then(({ data }) => {
    state.session = data.session;
    render();
  });

  sb.auth.onAuthStateChange((_event, session) => {
    const hadSession = !!state.session;
    state.session = session;
    if (!session) {
      state.profile = null;
      state.addFlow = null;
      state.rankFlow = null;
      state.showAuth = false; // logging out returns to the public rankings
    }
    if (!!session !== hadSession) render();
  });

  window.addEventListener("hashchange", render);
}

init();
