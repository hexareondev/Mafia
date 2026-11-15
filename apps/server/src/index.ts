import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  MIN_PLAYERS_TO_START,
  ROOM_CODE_LENGTH,
  type ClientToServerEvents,
  type InterServerEvents,
  type PlayerSummary,
  type Role,
  type RoomSnapshot,
  type ServerToClientEvents,
  type SocketData,
} from "@mafia/shared";

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS ?? process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "mafia-server" }));

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
  cors: { origin: CLIENT_ORIGINS, methods: ["GET", "POST"] },
});

type RoomPlayer = PlayerSummary & { socketId: string };
type Room = {
  code: string;
  players: RoomPlayer[];
  createdAt: number;
  status: "lobby" | "playing";
  roles: Map<string, Role>;
};
const rooms = new Map<string, Room>();
const socketRooms = new Map<string, string>();

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room: Room): PlayerSummary[] {
  return room.players.map(({ id, name, isHost, ready }) => ({ id, name, isHost, ready }));
}

function snapshot(room: Room): RoomSnapshot {
  return {
    code: room.code,
    players: publicPlayers(room),
    hostId: room.players.find((player) => player.isHost)?.id ?? null,
    status: room.status,
  };
}

function emitRoom(room: Room): void {
  io.to(room.code).emit("room:updated", snapshot(room));
}

function leaveCurrentRoom(socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>): void {
  const roomCode = socketRooms.get(socket.id);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socketRooms.delete(socket.id);
  socket.leave(roomCode);
  if (!room) return;

  room.players = room.players.filter((player) => player.socketId !== socket.id);
  room.roles.delete(socket.id);
  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }
  if (!room.players.some((player) => player.isHost)) {
    room.players[0]!.isHost = true;
    room.players[0]!.ready = false;
  }
  emitRoom(room);
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function createRoleDeck(playerCount: number): Role[] {
  // One mafia for 4–9 players, two for 10–12. Special town roles are present from 4 players.
  const mafiaCount = Math.max(1, Math.floor(playerCount / 5));
  const roles: Role[] = [
    ...Array.from({ length: mafiaCount }, () => "mafia" as const),
    "doctor",
    "detective",
  ];
  while (roles.length < playerCount) roles.push("citizen");
  return shuffle(roles);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ playerName }, callback) => {
    const name = playerName.trim().slice(0, 20);
    if (!name) return callback({ ok: false, error: "Введите имя игрока." });

    leaveCurrentRoom(socket);
    const code = makeRoomCode();
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: true, ready: false };
    const room: Room = { code, players: [player], createdAt: Date.now(), status: "lobby", roles: new Map() };
    rooms.set(code, room);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: snapshot(room) });
    emitRoom(room);
  });

  socket.on("room:join", ({ code: rawCode, playerName }, callback) => {
    const code = rawCode.trim().toUpperCase();
    const name = playerName.trim().slice(0, 20);
    const room = rooms.get(code);
    if (!name) return callback({ ok: false, error: "Введите имя игрока." });
    if (!room) return callback({ ok: false, error: "Комната не найдена. Проверьте код." });
    if (room.status !== "lobby") return callback({ ok: false, error: "Игра уже началась." });
    if (room.players.length >= 12) return callback({ ok: false, error: "В комнате уже 12 игроков." });
    if (room.players.some((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return callback({ ok: false, error: "Это имя уже занято в комнате." });
    }

    leaveCurrentRoom(socket);
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: false, ready: false };
    room.players.push(player);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: snapshot(room) });
    emitRoom(room);
  });

  socket.on("room:ready", ({ ready }, callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || room.status !== "lobby") {
      return callback({ ok: false, error: "Нельзя изменить готовность сейчас." });
    }
    const player = room.players.find((item) => item.socketId === socket.id);
    if (!player) return callback({ ok: false, error: "Игрок не найден в комнате." });
    player.ready = Boolean(ready);
    emitRoom(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("game:start", (callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room) return callback({ ok: false, error: "Комната не найдена." });
    if (room.players.find((player) => player.socketId === socket.id)?.isHost !== true) {
      return callback({ ok: false, error: "Только создатель комнаты может начать игру." });
    }
    if (room.status !== "lobby") return callback({ ok: false, error: "Игра уже запущена." });
    if (room.players.length < MIN_PLAYERS_TO_START) {
      return callback({ ok: false, error: `Для начала нужно минимум ${MIN_PLAYERS_TO_START} игрока.` });
    }
    if (!room.players.every((player) => player.ready)) {
      return callback({ ok: false, error: "Не все игроки готовы." });
    }

    const deck = createRoleDeck(room.players.length);
    room.roles.clear();
    room.players.forEach((player, index) => {
      const role = deck[index]!;
      room.roles.set(player.socketId, role);
      io.to(player.socketId).emit("game:role", role);
    });
    room.status = "playing";
    emitRoom(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("room:leave", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

httpServer.listen(PORT, () => {
  console.log(`Mafia server listening on port ${PORT}`);
});
