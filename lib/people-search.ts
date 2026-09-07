import type { Person } from "./check-in-contract";

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
}

/** A private nickname supplements the profile name; neither hides the other from search. */
export function matchesPersonSearch(person: Pick<Person, "nickname" | "user">, query: string): boolean {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  const names = searchable(`${person.user.displayName} ${person.nickname ?? ""}`);
  return words.every(word => names.includes(word));
}
