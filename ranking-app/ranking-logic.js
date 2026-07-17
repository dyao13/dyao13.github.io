/*
 * Pure ranking + scoring logic for the ranking app.
 * No DOM or Supabase dependencies so it can be unit-tested with Node
 * (see ranking-app/tests/ranking-logic.test.mjs).
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
 * Score for the tie group at `index` (0 = best) in a bucket holding `total`
 * tie groups. Movies judged "about the same" share a tie group and therefore
 * a score; each unique score level counts once here. The best group always
 * gets the bucket maximum and the worst the bucket minimum, with the rest
 * evenly spaced; a lone group sits at the top of its bucket.
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
 * Title of a rating row, whether it carries the title directly (the public
 * and community views) or nested under the joined `movies` record.
 */
export function ratingTitle(rating) {
  return rating.movies?.title ?? rating.title ?? "";
}

/*
 * Sort comparator for one bucket's rating rows: best rank first, and
 * alphabetical by title within a tie group so tied movies always display in
 * a stable order (the database returns them in arbitrary order otherwise).
 */
export function compareRatings(a, b) {
  if (a.rank_position !== b.rank_position) return a.rank_position - b.rank_position;
  return ratingTitle(a).localeCompare(ratingTitle(b), undefined, { sensitivity: "base" });
}

/*
 * Group a bucket list (ordered best to worst by rank_position) into tie
 * groups: consecutive rows sharing a rank_position were judged "about the
 * same" and form one group.
 */
export function groupTies(list) {
  const groups = [];
  for (const item of list) {
    const last = groups[groups.length - 1];
    if (last && last[0].rank_position === item.rank_position) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

/*
 * Binary-insertion comparison state over tie groups. The existing groups are
 * ordered best (index 0) to worst. Each step compares the new movie against
 * a movie from the group at `nextComparisonIndex(state)` until low === high.
 * The result is either a new group inserted at index `low`, or — when the
 * user answered "about the same" — joining the existing group at `low`
 * (`state.tie` is true).
 */
export function createInsertionState(existingCount) {
  return { low: 0, high: existingCount, tie: false };
}

export function isInsertionDone(state) {
  return state.low >= state.high;
}

export function nextComparisonIndex(state) {
  return Math.floor((state.low + state.high) / 2);
}

/*
 * `outcome` is "new" (liked the new movie more), "existing" (liked the
 * compared movie more), or "same" (about the same — ends the search by
 * joining the compared group). Booleans are accepted as a shorthand:
 * true = "new", false = "existing".
 */
export function applyComparison(state, outcome) {
  const mid = nextComparisonIndex(state);

  if (outcome === "same") {
    return { low: mid, high: mid, tie: true };
  }

  if (outcome === true || outcome === "new") {
    return { low: state.low, high: mid, tie: false };
  }

  return { low: mid + 1, high: state.high, tie: false };
}

export function insertAt(list, index, item) {
  const copy = list.slice();
  copy.splice(index, 0, item);
  return copy;
}

/*
 * Merge the new movie id into the existing tie groups (arrays of movie ids,
 * best to worst) according to a finished insertion state, and flatten the
 * result into the parallel arrays the rank_movie RPC expects: `orderedIds`
 * best to worst, and `groupIndices` giving each id's dense tie-group index.
 */
export function buildRankedOrder(groups, insertion, newMovieId) {
  const merged = insertion.tie
    ? groups.map((g, i) => (i === insertion.low ? [...g, newMovieId] : g))
    : insertAt(groups, insertion.low, [newMovieId]);

  const orderedIds = [];
  const groupIndices = [];
  merged.forEach((group, groupIndex) => {
    for (const id of group) {
      orderedIds.push(id);
      groupIndices.push(groupIndex);
    }
  });
  return { orderedIds, groupIndices };
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

/*
 * 1-indexed overall rank of a rating, for display. `ratings` is all of the
 * user's ratings for the medium. Uses competition ranking: tied movies share
 * a rank and the next group skips past them (1, 1, 3, ...), so the worst
 * movie's rank always equals the total count.
 */
export function overallRank(rating, ratings) {
  const offsets = bucketOffsets(ratings);
  const better = ratings.filter(
    (r) => r.bucket === rating.bucket && r.rank_position < rating.rank_position
  ).length;
  return offsets[rating.bucket] + better + 1;
}
