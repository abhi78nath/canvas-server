

const WORD_BANK = [
  "apple",
  "mountain",
  "river",
  "cat",
  "bicycle",
  "sun",
  "computer",
  "tree",
  "book",
  "ocean",
  "house",
  "music",
  "flower",
  "pizza",
  "rocket",
  "cloud",
  "guitar",
  "elephant",
  "camera",
  "star",
  "bridge",
  "moon",
  "key",
  "chair",
  "coffee",
  "dance",
  "fire",
  "hat",
  "island",
  "jungle",
  "king",
  "lemon",
  "money",
  "ninja",
  "orange",
  "pencil",
  "queen",
  "robot",
  "snake",
  "turtle",
  "unicorn",
  "volcano",
  "watch",
  "xylophone",
  "yacht",
  "zebra",
];

export function getRandomWords(count: number): string[] {
  const pool = [...WORD_BANK];
  const result: string[] = [];
  const picks = Math.min(count, pool.length);
  for (let i = 0; i < picks; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}
