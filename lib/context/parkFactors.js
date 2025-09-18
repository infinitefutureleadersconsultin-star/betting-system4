// Small, safe MLB park adjustments for strikeouts (Ks).
// Values are gentle nudges to expected Ks (not probabilities).
export const MLB_PARK_K_ADJ = {
  // team code -> additive adjustment to expected Ks (mu)
  // Coors (COL) slightly lowers Ks, pitcher-friendly parks tiny bumps
  "COL": -0.30, // Coors Field - hitters' park -> slightly fewer Ks
  "SD":  0.10,
  "SEA": 0.10,
  "TB":  0.10,
  "NYM": 0.05,
  "MIA": 0.05
};
