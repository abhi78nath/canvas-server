const MAX_TIME_SECONDS = 80;
const FIRST_GUESSER_BASE_POINTS = 500;
const DRAWER_TIME_BONUS_BASE = 500;
const DRAWER_PER_GUESS_BONUS = 50;
const SUBSEQUENT_GUESSER_POINTS = [400, 300, 200, 100];
const MIN_GUESSER_POINTS = 50;

/**
 * Calculates the points for a player who guesses the word correctly.
 * @param guesserRank The order in which the player guessed (e.g., 1 for the first guesser).
 * @param timeLeft The time remaining in the round in seconds.
 * @returns The calculated points for the guesser.
 */
export function calculateGuesserPoints(guesserRank: number, timeLeft: number): number {
  if (guesserRank === 1) {
    // The first guesser gets points based on how much time is left.
    const points = Math.round(FIRST_GUESSER_BASE_POINTS * (timeLeft / MAX_TIME_SECONDS));
    return Math.max(MIN_GUESSER_POINTS, points); // Ensure a minimum score
  }

  // Subsequent guessers get a fixed, decreasing amount.
  const pointsIndex = guesserRank - 2; // -1 for 0-based index, -1 to account for 1st guesser.
  return SUBSEQUENT_GUESSER_POINTS[pointsIndex] || MIN_GUESSER_POINTS;
}

/**
 * Calculates the total points for the drawer based on guesser performance.
 * @param correctGuessersCount The total number of players who guessed correctly.
 * @param timeLeftOnLastGuess The time remaining when the last correct guess was made.
 * @returns The calculated points for the drawer for that turn.
 */
export function calculateDrawerPoints(correctGuessersCount: number, timeLeftOnLastGuess: number): number {
  if (correctGuessersCount === 0) {
    return 0;
  }

  const perGuessBonus = DRAWER_PER_GUESS_BONUS * correctGuessersCount;
  const timeBonus = Math.round(DRAWER_TIME_BONUS_BASE * (timeLeftOnLastGuess / MAX_TIME_SECONDS));

  return perGuessBonus + timeBonus;
}
