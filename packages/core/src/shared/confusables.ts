/**
 * Folds the Cyrillic and Greek letters most commonly used to spoof a Latin ASCII word — the classic
 * homograph-phishing set ("Оwner" with Cyrillic О, "Faсebook" with Cyrillic с) — to their Latin
 * look-alike. Unlike NFD-based diacritic stripping, Unicode normalization never merges these: they
 * are different letters that happen to render identically in most fonts, not accented variants of
 * the same letter. Not the full Unicode confusables table (thousands of entries covering scripts no
 * UNIORA name is likely to mix with Latin) — just the single-codepoint look-alikes that actually
 * matter for an ASCII word like a role or permission name, so two names that *read* the same also
 * *compare* the same.
 */
const CONFUSABLE_TO_LATIN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Cyrillic lowercase/uppercase that render as a Latin letter in sans-serif and most UI fonts.
    а: "a", А: "a",
    с: "c", С: "c",
    е: "e", Е: "e",
    і: "i", І: "i", ї: "i", Ї: "i",
    ј: "j",
    к: "k", К: "k",
    о: "o", О: "o",
    р: "p", Р: "p",
    ѕ: "s", Ѕ: "s",
    т: "t", Т: "t",
    у: "y", У: "y",
    х: "x", Х: "x",
    // Greek that render as a Latin letter.
    α: "a", Α: "a",
    ϲ: "c",
    ε: "e", Ε: "e",
    ι: "i", Ι: "i",
    κ: "k", Κ: "k",
    ο: "o", Ο: "o",
    ρ: "p", Ρ: "p",
    τ: "t", Τ: "t",
    υ: "u", Υ: "u",
    χ: "x", Χ: "x",
    ν: "v", Ν: "n",
  }),
);

/** Unicode default-ignorable / bidi-control code points: no legitimate reason to appear in a display name, every reason to hide one. */
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_BIDI = /[­​-‏‪-‮⁠-⁤﻿]/u;

export function containsInvisibleOrBidiControl(text: string): boolean {
  return INVISIBLE_OR_BIDI.test(text);
}

/** `text`, with every known Latin look-alike folded to the Latin letter it is confused with. For comparing, never for display. */
export function toConfusableSkeleton(text: string): string {
  return [...text].map((char) => CONFUSABLE_TO_LATIN.get(char) ?? char).join("");
}
