import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false } });
const { matchesPersonSearch } = await vite.ssrLoadModule("/lib/people-search.ts");
after(() => vite.close());
const person = { user: { displayName: "Алёна Иванова", publicId: "ABCD-EFGH-JKLM" }, nickname: "Мама" };

test("finds either the original name or private nickname regardless of case and ё", () => {
  for (const query of ["АЛЕНА", "Алёна", "  мама  ", "иванова алена", "МаМа Иванова"]) {
    assert.equal(matchesPersonSearch(person, query), true, query);
  }
  assert.equal(matchesPersonSearch(person, "иванова отец"), false);
  assert.equal(matchesPersonSearch({ ...person, nickname: null }, "алена"), true);
});

test("empty search preserves all people and filtering preserves their original order", () => {
  const people = [person, { user: { displayName: "Друг" }, nickname: null }, { user: { displayName: "Алёна Петрова" }, nickname: "Работа" }];
  assert.deepEqual(people.filter(p => matchesPersonSearch(p, "  ")), people);
  assert.deepEqual(people.filter(p => matchesPersonSearch(p, "алена")), [people[0], people[2]]);
  assert.deepEqual(people.filter(p => matchesPersonSearch(p, "никого")), []);
});
