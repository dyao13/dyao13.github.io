/*
 * Pure ranking + scoring logic for the MovieRank app.
 * No DOM or Supabase dependencies so it can be unit-tested with Node
 * (see tests/movies-ranking.test.mjs).
 */

export const BUCKETS = ["green", "yellow", "red"];

export function getBucketRange(bucket) {
  if (bucket === "green") {
    return { min: 6.7, max: 10.0 };
  }

  if (bucket === "yellow") {
    return { min: 3.4, max: 6.6 };
  }

  if (bucket === "red") {
    return { min: 0.0, max: 3.3 };
  }

  throw new Error(`Unknown bucket: ${bucket}`);
}

export function bucketLabel(bucket) {
  if (bucket === "green") return "I liked it";
  if (bucket === "yellow") return "It was fine";
  if (bucket === "red") return "I didn't like it";
  throw new Error(`Unknown bucket: ${bucket}`);
}

export function roundToOneDecimal(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/*
 * Score for the movie at `index` (0 = best) in a bucket holding `total`
 * movies. The best movie always gets the bucket maximum and the worst the
 * bucket minimum, with the rest evenly spaced; a lone movie sits at the
 * top of its bucket.
 */
export function scoreForPosition(index, total, bucket) {
  const { min, max } = getBucketRange(bucket);

  if (total === 1) {
    return roundToOneDecimal(max);
  }

  const t = index / (total - 1);
  const score = max - t * (max - min);

  return roundToOneDecimal(score);
}

export function formatScore(score) {
  return Number(score).toFixed(1);
}

/*
 * Binary-insertion comparison state. The existing bucket list is ordered
 * best (index 0) to worst. Each step compares the new movie against the
 * movie at `nextComparisonIndex(state)` until low === high, which is the
 * insertion index.
 */
export function createInsertionState(existingCount) {
  return { low: 0, high: existingCount };
}

export function isInsertionDone(state) {
  return state.low >= state.high;
}

export function nextComparisonIndex(state) {
  return Math.floor((state.low + state.high) / 2);
}

export function applyComparison(state, prefersNewMovie) {
  const mid = nextComparisonIndex(state);

  if (prefersNewMovie) {
    return { low: state.low, high: mid };
  }

  return { low: mid + 1, high: state.high };
}

export function insertAt(list, index, item) {
  const copy = list.slice();
  copy.splice(index, 0, item);
  return copy;
}

/*
 * Display numbering is unified across the three colors: green movies come
 * first, then yellow, then red. Given all of a user's ratings, returns the
 * amount to add to a rating's within-bucket rank_position to get its
 * zero-indexed overall position.
 */
export function bucketOffsets(ratings) {
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const r of ratings) {
    if (counts[r.bucket] === undefined) throw new Error(`Unknown bucket: ${r.bucket}`);
    counts[r.bucket] += 1;
  }
  return {
    green: 0,
    yellow: counts.green,
    red: counts.green + counts.yellow,
  };
}

/* 1-indexed overall rank of a rating, for display. */
export function overallRank(rating, offsets) {
  return rating.rank_position + offsets[rating.bucket] + 1;
}
