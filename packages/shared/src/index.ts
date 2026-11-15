export const ROOM_CODE_LENGTH = 5;
export const MIN_PLAYERS_TO_START = 4;

export type Role = "mafia" | "doctor" | "detective" | "citizen";

export type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  ready: boolean;
};

export type RoomSnapshot = {
  code: string;
  players: PlayerSummary[];
  hostId: string | null;
  status: "lobby" | "playing";
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
}

export interface ServerToClientEvents {
  "room:updated": (room: RoomSnapshot) => void;
  "game:role": (role: Role) => void;
}

export interface InterServerEvents {}

export interface SocketData {}
