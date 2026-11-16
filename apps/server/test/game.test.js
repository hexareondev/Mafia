import test from "node:test";
import assert from "node:assert/strict";
import { createRoleDeck, getUniqueVoteLeader, getWinner } from "../dist/game.js";

test("role deck has exactly one doctor and detective and scales mafia count", () => {
  for (const playerCount of [4, 5, 6, 9, 10, 11, 12]) {
    const roles = createRoleDeck(playerCount);
    assert.equal(roles.length, playerCount);
    assert.equal(roles.filter((role) => role === "doctor").length, 1);
    assert.equal(roles.filter((role) => role === "detective").length, 1);
    assert.equal(roles.filter((role) => role === "mafia").length, Math.max(1, Math.floor(playerCount / 5)));
    assert.equal(roles.filter((role) => role === "citizen").length, playerCount - Math.max(1, Math.floor(playerCount / 5)) - 2);
  }
});

test("town wins when no mafia remain", () => {
  assert.equal(getWinner(["doctor", "detective", "citizen"]), "town");
});

test("mafia wins at parity or majority", () => {
  assert.equal(getWinner(["mafia", "citizen"]), "mafia");
  assert.equal(getWinner(["mafia", "mafia", "citizen"]), "mafia");
});

test("game continues while town outnumbers mafia", () => {
  assert.equal(getWinner(["mafia", "doctor", "detective", "citizen"]), null);
});

test("vote tally returns a unique leader", () => {
  assert.equal(getUniqueVoteLeader(["p1", "p2", "p1", "p3", "p1", "p2"]), "p1");
});

test("vote tally returns null for a tie or no votes", () => {
  assert.equal(getUniqueVoteLeader(["p1", "p2", "p1", "p2"]), null);
  assert.equal(getUniqueVoteLeader([]), null);
});
