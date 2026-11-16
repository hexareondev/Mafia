import test from "node:test";
import assert from "node:assert/strict";
import { createRoleDeck, getUniqueVoteLeader, getWinner } from "../dist/game.js";

test("role deck contains exactly one doctor and detective", () => {
  for (let playerCount = 4; playerCount <= 12; playerCount += 1) {
    const roles = createRoleDeck(playerCount);
    assert.equal(roles.length, playerCount, `player count: ${playerCount}`);
    assert.equal(roles.filter((role) => role === "doctor").length, 1);
    assert.equal(roles.filter((role) => role === "detective").length, 1);
    assert.equal(roles.filter((role) => role === "mafia").length,
      playerCount >= 10 ? 2 : 1);
    assert.equal(roles.filter((role) => role === "citizen").length,
      playerCount - (playerCount >= 10 ? 4 : 3));
  }
});

test("role deck rejects no supported player counts by silently changing its size", () => {
  for (const playerCount of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(createRoleDeck(playerCount).length, playerCount);
  }
});

test("town wins when the last mafia member is eliminated", () => {
  assert.equal(getWinner(["doctor", "detective", "citizen"]), "town");
});

test("mafia wins at parity or majority", () => {
  assert.equal(getWinner(["mafia", "citizen"]), "mafia");
  assert.equal(getWinner(["mafia", "mafia", "citizen"]), "mafia");
});

test("game continues while town outnumbers mafia", () => {
  assert.equal(getWinner(["mafia", "doctor", "detective", "citizen"]), null);
});

test("day vote returns the only leading target", () => {
  assert.equal(getUniqueVoteLeader(["p1", "p1", "p2"]), "p1");
  assert.equal(getUniqueVoteLeader(["p1", "p2", "p1", "p3", "p1"]), "p1");
});

test("day vote returns no target for a tie or no votes", () => {
  assert.equal(getUniqueVoteLeader(["p1", "p1", "p2", "p2"]), null);
  assert.equal(getUniqueVoteLeader([]), null);
});

test("vote outcome is independent of vote order", () => {
  assert.equal(getUniqueVoteLeader(["p2", "p1", "p2"]), "p2");
  assert.equal(getUniqueVoteLeader(["p2", "p2", "p1"]), "p2");
});
