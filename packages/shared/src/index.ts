export const ROOM_CODE_LENGTH = 5;
export const MIN_PLAYERS_TO_START = 4;

export type Role = "mafia" | "doctor" | "detective" | "citizen";
export type GamePhase = "night" | "day";
export type GameWinner = "mafia" | "town";

export type ChatMessage = { id: string; playerId: string; playerName: string; text: string; sentAt: number };

export type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  ready: boolean;
  alive: boolean;
};

export type RoomSnapshot = {
  code: string;
  players: PlayerSummary[];
  hostId: string | null;
  status: "lobby" | "playing" | "finished";
  phase: GamePhase | null;
  dayNumber: number;
  winner: GameWinner | null;
  lastNightMessage: string | null;
  lastDayMessage: string | null;
  chatMessages: ChatMessage[];
};

export type ActionResult =
  | { ok: true; room: RoomSnapshot }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  "room:create": (payload: { playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:join": (payload: { code: string; playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:leave": () => void;
  "room:ready": (payload: { ready: boolean }, callback: (result: ActionResult) => void) => void;
  "game:start": (callback: (result: ActionResult) => void) => void;
  "game:night-action": (payload: { targetId: string }, callback: (result: ActionResult) => void) => void;
  "game:day-vote": (payload: { targetId: string }, callback: (result: ActionResult) => void) => void;
  "chat:send": (payload: { text: string }, callback: (result: ActionResult) => void) => void;
}

export interface ServerToClientEvents {
  "room:updated": (room: RoomSnapshot) => void;
  "game:role": (role: Role) => void;
  "game:mafia-team": (playerIds: string[]) => void;
  "game:investigation-result": (result: { targetId: string; targetName: string; isMafia: boolean }) => void;
}

export interface InterServerEvents {}

export interface SocketData {}
