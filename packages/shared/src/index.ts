export const ROOM_CODE_LENGTH = 5;

export type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
};

export type RoomSnapshot = {
  code: string;
  players: PlayerSummary[];
  hostId: string | null;
};

export type ActionResult =
  | { ok: true; room: RoomSnapshot }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  "room:create": (payload: { playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:join": (payload: { code: string; playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:leave": () => void;
}

export interface ServerToClientEvents {
  "room:updated": (room: RoomSnapshot) => void;
}

export interface InterServerEvents {}

export interface SocketData {}
