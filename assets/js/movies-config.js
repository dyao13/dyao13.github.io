/*
 * Supabase project settings for the MovieRank app.
 *
 * Fill these in from your Supabase dashboard: Project Settings -> API.
 * The URL and the anon (public) key are safe to publish ONLY because the
 * database enforces Row Level Security (see supabase/schema.sql).
 *
 * NEVER put the service_role key (or any other secret) in this file.
 */

export const SUPABASE_URL = "https://ragtdouufhgszigmigah.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhZ3Rkb3V1Zmhnc3ppZ21pZ2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0NDgzNzQsImV4cCI6MjA5OTAyNDM3NH0.0RBc2S7FxltYhuAT8ou2lKVlk0dXIlBhnGtH_9ORe9I";

/*
 * Optional: TMDB (themoviedb.org) API key for movie search.
 *
 * Get a free key: create an account at https://www.themoviedb.org, then go
 * to Settings -> API and request a key. Paste either the "API Key" (v3) or
 * the "API Read Access Token" (v4, starts with "eyJ") below — both work.
 *
 * Leave it as "" to keep manual movie entry only. Note that anyone who
 * views the site source can see this key; TMDB keys are free and only
 * allow reading public movie data, but use a dedicated key for this site.
 */

export const TMDB_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIzYWUwNGY1MzM0MDk1ZTU3Mjc1Y2MxOTYwNjQzYTk5YSIsIm5iZiI6MTc4MzQ1NzM0My43NCwic3ViIjoiNmE0ZDY2M2Y2OTg0ZjljNDFlYjE2YWMxIiwic2NvcGVzIjpbImFwaV9yZWFkIl0sInZlcnNpb24iOjF9.2iqs9KryAdiLXg_PJfUVvO3QSHCHxuPdhuY98za-lgU";
