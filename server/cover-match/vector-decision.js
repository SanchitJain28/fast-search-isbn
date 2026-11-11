export function coverVectorDecision(hits, { minimumScore, minimumGap }) {
  const [first, second] = hits;
  if (!first || first.score < minimumScore) return 'fallback';
  if (first.sharedCover || (second && first.score - second.score <= minimumGap)) return 'review';
  return 'suggest';
}
