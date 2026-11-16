import { randomInt } from "node:crypto";
import type { GameWinner, Role } from "@mafia/shared";

export function createRoleDeck(playerCount: number): Role[] {
  const mafiaCount = Math.max(1, Math.floor(playerCount / 5));
  const roles: Role[] = [
    ...Array.from({ length: mafiaCount }, () => "mafia" as const),
    "doctor",
    "detective",
  ];
  while (roles.length < playerCount) roles.push("citizen");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j]!, roles[i]!];
  }
  return roles;
}

export function getWinner(aliveRoles: Role[]): GameWinner | null {
  const mafia = aliveRoles.filter((role) => role === "mafia").length;
  const town = aliveRoles.length - mafia;
  if (mafia === 0) return "town";
  if (mafia >= town) return "mafia";
  return null;
}

/** Returns the sole leading target, or null for no votes / a tie. */
export function getUniqueVoteLeader(votes: Iterable<string>): string | null {
  const counts = new Map<string, number>();
  for (const targetId of votes) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  if (counts.size === 0) return null;
  const highest = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === highest);
  return leaders.length === 1 ? leaders[0]![0] : null;
}
