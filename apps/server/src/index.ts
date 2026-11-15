import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  ROOM_CODE_LENGTH,
  type ClientToServerEvents,
  type InterServerEvents,
  type PlayerSummary,
  type ServerToClientEvents,
  type SocketData,
} from "@mafia/shared";

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "mafia-server" }));

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
});

type RoomPlayer = PlayerSummary & { socketId: string };
type Room = { code: string; players: RoomPlayer[]; createdAt: number };
const rooms = new Map<string, Room>();
const socketRooms = new Map<string, string>();

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room: Room): PlayerSummary[] {
  return room.players.map(({ id, name, isHost }) => ({ id, name, isHost }));
}

function emitRoom(room: Room): void {
  io.to(room.code).emit("room:updated", {
    code: room.code,
    players: publicPlayers(room),
    hostId: room.players.find((player) => player.isHost)?.id ?? null,
  });
}

function leaveCurrentRoom(socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>): void {
  const roomCode = socketRooms.get(socket.id);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socketRooms.delete(socket.id);
  socket.leave(roomCode);
  if (!room) return;

  room.players = room.players.filter((player) => player.socketId !== socket.id);
  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }
  if (!room.players.some((player) => player.isHost)) room.players[0]!.isHost = true;
  emitRoom(room);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ playerName }, callback) => {
    const name = playerName.trim().slice(0, 20);
    if (!name) return callback({ ok: false, error: "Введите имя игрока." });

    leaveCurrentRoom(socket);
    const code = makeRoomCode();
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: true };
    const room: Room = { code, players: [player], createdAt: Date.now() };
    rooms.set(code, room);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: { code, players: publicPlayers(room), hostId: player.id } });
    emitRoom(room);
  });

  socket.on("room:join", ({ code: rawCode, playerName }, callback) => {
    const code = rawCode.trim().toUpperCase();
    const name = playerName.trim().slice(0, 20);
    const room = rooms.get(code);
    if (!name) return callback({ ok: false, error: "Введите имя игрока." });
    if (!room) return callback({ ok: false, error: "Комната не найдена. Проверьте код." });
    if (room.players.length >= 12) return callback({ ok: false, error: "В комнате уже 12 игроков." });
    if (room.players.some((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return callback({ ok: false, error: "Это имя уже занято в комнате." });
    }

    leaveCurrentRoom(socket);
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: false };
    room.players.push(player);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: { code, players: publicPlayers(room), hostId: room.players.find((p) => p.isHost)?.id ?? null } });
    emitRoom(room);
  });

  socket.on("room:leave", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

httpServer.listen(PORT, () => {
  console.log(`Mafia server listening on http://localhost:${PORT}`);
});
