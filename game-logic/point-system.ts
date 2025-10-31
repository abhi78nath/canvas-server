/**
 * Calculates the points for a guesser based on time left and their rank.
 * The first guesser gets the most points, with subsequent guessers getting less.
 * @param timeLeftInSeconds - The time remaining in the round.
 * @param totalDurationInSeconds - The total duration of the round.
 * @param guesserRank - The rank of the guesser (0 for first, 1 for second, etc.).
 * @returns The calculated points for the guesser.
 */
export function calculateGuesserScore(
  timeLeftInSeconds: number,
  totalDurationInSeconds: number,
  guesserRank: number
): number {
  // The max points decrease for later guessers (500, 400, 300, ...)
  const maxPointsForRank = Math.max(50, 500 - guesserRank * 100);
  
  // The score is proportional to the time left.
  const points = maxPointsForRank * (timeLeftInSeconds / totalDurationInSeconds);
  
  return Math.round(points);
}

/**
 * Calculates the points for the drawer based on the number of correct guesses
 * and the time remaining when the last guess was made.
 * @param correctGuesserCount - The number of players who guessed correctly.
 * @param timeLeftOnLastGuessInSeconds - The time left when the final correct guess was made.
 * @param totalDurationInSeconds - The total duration of the round.
 * @returns The calculated points for the drawer.
 */
export function calculateDrawerScore(
  correctGuesserCount: number,
  timeLeftOnLastGuessInSeconds: number,
  totalDurationInSeconds: number
): number {
  if (correctGuesserCount === 0) {
    return 0;
  }
  
  // 50 points for each player who guessed correctly.
  const guesserBonus = 50 * correctGuesserCount;
  
  // A time-based bonus for how quickly the word was guessed.
  const timeBonus = 500 * (timeLeftOnLastGuessInSeconds / totalDurationInSeconds);
  
  return Math.round(guesserBonus + timeBonus);
}
