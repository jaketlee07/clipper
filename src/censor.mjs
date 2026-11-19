// Censor: stars out swearing in the text a viewer reads (burned-in captions, the
// hook, the post caption) for campaigns with "censorCaptions": true. Platforms
// push clips with profanity in the text less, and some briefs ban it. The audio
// is left alone.

// Each root and which of its letters to star: fuck -> f*ck, asshole -> a**hole.
const ROOTS = {
  fuck: [1], shit: [2], bitch: [1], cunt: [1], dick: [1], pussy: [1], cock: [1], twat: [2],
  asshole: [1, 2], dumbass: [5, 6], jackass: [5, 6], bastard: [1], whore: [2], slut: [2],
  nigga: [1, 2, 3], nigger: [1, 2, 3, 4], fag: [1], faggot: [1], retard: [1],
};
// Compounds that are still the same swear (motherfucker, bullshit).
const PREFIXES = { fuck: ["mother", "cluster"], shit: ["bull", "horse", "dip", "chicken", "holy"] };
// Endings that keep a root a swear. Anything else is a different word
// (cocktail, peacock, Dickens), so it's left alone.
const SUFFIXES = new Set(["", "s", "es", "'s", "ed", "er", "ers", "in", "ing", "ings", "y", "ty", "head", "heads", "face", "hole", "holes"]);

function maskWord(token, roots) {
  const low = token.toLowerCase();
  for (const [root, stars] of roots) {
    const at = low.indexOf(root);
    if (at < 0) continue;
    const before = low.slice(0, at);
    const after = low.slice(at + root.length).replace(/'$/, "");
    if (before && !(PREFIXES[root] ?? []).includes(before)) continue;
    if (!SUFFIXES.has(after)) continue;
    const chars = [...token];
    for (const i of stars) if (chars[at + i]) chars[at + i] = "*";
    return chars.join("");
  }
  return token;
}

// A function that censors text for this campaign (or passes it through).
// `censorWords` adds the campaign's own words, starred between the first and
// last letter.
export function censorFor(campaign) {
  if (!campaign.censorCaptions) return (text) => text;
  const roots = Object.entries(ROOTS);
  for (const word of campaign.censorWords ?? []) {
    const w = word.toLowerCase();
    roots.push([w, [...Array(Math.max(0, w.length - 2)).keys()].map((i) => i + 1)]);
  }
  // Longest roots first, so "asshole" wins over anything shorter inside it.
  roots.sort((a, b) => b[0].length - a[0].length);
  return (text) => text.replace(/[A-Za-z]+(?:'[A-Za-z]*)?/g, (token) => maskWord(token, roots));
}
