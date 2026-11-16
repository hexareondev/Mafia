import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { deleteStoredRoom, initializeRoomStorage, saveStoredRoom } from "./storage.js";
import { createRoleDeck, getUniqueVoteLeader, getWinner } from "./game.js";
import { Server, type Socket } from "socket.io";
import {
  MIN_PLAYERS_TO_START,
  ROOM_CODE_LENGTH,
  type ChatMessage,
  type ClientToServerEvents,
  type GameWinner,
  type InterServerEvents,
  type PlayerSummary,
  type Role,
  type RoomSnapshot,
  type ServerToClientEvents,
  type SocketData,
} from "@mafia/shared";

const PORT = Number(process.env.PORT ?? 3001);
const NIGHT_DURATION_MS = Math.max(15, Number(process.env.NIGHT_DURATION_SECONDS ?? 60)) * 1000;
const DAY_DURATION_MS = Math.max(30, Number(process.env.DAY_DURATION_SECONDS ?? 180)) * 1000;
const DISCONNECT_GRACE_MS = 2 * 60 * 1000;
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
  connectionStateRecovery: { maxDisconnectionDuration: DISCONNECT_GRACE_MS, skipMiddlewares: true },
});

type RoomPlayer = PlayerSummary & { socketId: string; reconnectTokenHash: string };
type Room = {
  code: string;
  players: RoomPlayer[];
  createdAt: number;
  status: "lobby" | "playing" | "finished";
  phase: "night" | "day" | null;
  phaseEndsAt: number | null;
  dayNumber: number;
  winner: GameWinner | null;
  lastNightMessage: string | null;
  lastDayMessage: string | null;
  chatMessages: ChatMessage[];
  dayVotes: Map<string, string>;
  roles: Map<string, Role>;
  mafiaVotes: Map<string, string>;
  doctorTarget: string | null;
  detectiveActed: boolean;
};

const rooms = new Map<string, Room>();
const socketRooms = new Map<string, string>();
const phaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function hashReconnectToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, storedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const actual = Buffer.from(hashReconnectToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendPrivatePlayerState(room: Room, player: RoomPlayer, socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>): void {
  const role = room.roles.get(player.id);
  if (!role) return;
  socket.emit("game:role", role);
  if (role === "mafia") {
    socket.emit("game:mafia-team", room.players
      .filter((member) => room.roles.get(member.id) === "mafia")
      .map((member) => member.id));
  }
}

function clearPhaseTimer(room: Room): void {
  const timer = phaseTimers.get(room.code);
  if (timer) clearTimeout(timer);
  phaseTimers.delete(room.code);
}

function schedulePhaseTimer(room: Room): void {
  clearPhaseTimer(room);
  if (room.status !== "playing" || !room.phase || room.phaseEndsAt === null) return;
  const timer = setTimeout(() => {
    phaseTimers.delete(room.code);
    if (room.status !== "playing") return;
    if (room.phase === "night") resolveNight(room, true);
    else if (room.phase === "day") resolveDay(room, true);
  }, Math.max(0, room.phaseEndsAt - Date.now()));
  phaseTimers.set(room.code, timer);
}

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room: Room): PlayerSummary[] {
  return room.players.map(({ id, name, isHost, ready, alive }) => ({ id, name, isHost, ready, alive }));
}

function snapshot(room: Room): RoomSnapshot {
  return {
    code: room.code,
    players: publicPlayers(room),
    hostId: room.players.find((player) => player.isHost)?.id ?? null,
    status: room.status,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    dayNumber: room.dayNumber,
    winner: room.winner,
    lastNightMessage: room.lastNightMessage,
    lastDayMessage: room.lastDayMessage,
    chatMessages: room.chatMessages,
  };
}

function emitRoom(room: Room): void {
  io.to(room.code).emit("room:updated", snapshot(room));
  void saveStoredRoom(room).catch((error: unknown) => {
    console.error(`Failed to persist room ${room.code}:`, error);
  });
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function countAlive(room: Room, role?: Role): number {
  return room.players.filter((player) => player.alive && (!role || room.roles.get(player.id) === role)).length;
}

function checkWinner(room: Room): GameWinner | null {
  const aliveRoles = room.players
    .filter((player) => player.alive)
    .map((player) => room.roles.get(player.id))
    .filter((role): role is Role => role !== undefined);
  return getWinner(aliveRoles);
}

function finishIfWinner(room: Room): boolean {
  const winner = checkWinner(room);
  if (!winner) return false;
  room.status = "finished";
  room.phase = null;
  room.phaseEndsAt = null;
  clearPhaseTimer(room);
  room.winner = winner;
  emitRoom(room);
  return true;
}

function nightActionsComplete(room: Room): boolean {
  const livingMafia = room.players.filter((player) => player.alive && room.roles.get(player.id) === "mafia");
  const doctorAlive = countAlive(room, "doctor") > 0;
  const detectiveAlive = countAlive(room, "detective") > 0;
  return livingMafia.every((player) => room.mafiaVotes.has(player.id))
    && (!doctorAlive || room.doctorTarget !== null)
    && (!detectiveAlive || room.detectiveActed);
}

function resolveNight(room: Room, timedOut = false): void {
  if (room.status !== "playing" || room.phase !== "night" || (!timedOut && !nightActionsComplete(room))) return;
  clearPhaseTimer(room);

  const voteCounts = new Map<string, number>();
  for (const targetId of room.mafiaVotes.values()) {
    voteCounts.set(targetId, (voteCounts.get(targetId) ?? 0) + 1);
  }

  let victimId: string | null = null;
  if (voteCounts.size > 0) {
    const highest = Math.max(...voteCounts.values());
    const tiedTargets = [...voteCounts.entries()].filter(([, votes]) => votes === highest).map(([targetId]) => targetId);
    victimId = tiedTargets[randomInt(tiedTargets.length)]!;
  }

  const saved = victimId !== null && victimId === room.doctorTarget;
  const victim = victimId ? room.players.find((player) => player.id === victimId && player.alive) : undefined;
  if (victim && !saved) {
    victim.alive = false;
    room.lastNightMessage = `Этой ночью погиб игрок «${victim.name}».`;
  } else if (victim && saved) {
    room.lastNightMessage = "Этой ночью доктор спас выбранного игрока. Никто не погиб.";
  } else {
    room.lastNightMessage = "Этой ночью никто не погиб.";
  }

  room.mafiaVotes.clear();
  room.doctorTarget = null;
  room.detectiveActed = false;

  if (!finishIfWinner(room)) {
    room.phase = "day";
    room.phaseEndsAt = Date.now() + DAY_DURATION_MS;
    schedulePhaseTimer(room);
  }
  emitRoom(room);
}

function resolveDay(room: Room, timedOut = false): void {
  if (room.status !== "playing" || room.phase !== "day") return;
  const livingPlayers = room.players.filter((player) => player.alive);
  if (!timedOut && !livingPlayers.every((player) => room.dayVotes.has(player.id))) return;
  clearPhaseTimer(room);

  const leadingTargetId = getUniqueVoteLeader(room.dayVotes.values());
  if (leadingTargetId !== null) {
    const targetId = leadingTargetId;
    const voteCount = [...room.dayVotes.values()].filter((id) => id === targetId).length;
    const eliminated = room.players.find((player) => player.id === targetId && player.alive);
    if (eliminated) {
      eliminated.alive = false;
      room.lastDayMessage = `Игрок «${eliminated.name}» исключён голосованием (${voteCount} голосов).`;
    } else {
      room.lastDayMessage = "Голосование не привело к исключению игрока.";
    }
  } else {
    room.lastDayMessage = room.dayVotes.size === 0
      ? "Никто не проголосовал. Никто не исключён."
      : "Голоса разделились поровну. Никто не исключён.";
  }

  room.dayVotes.clear();
  if (!finishIfWinner(room)) {
    room.phase = "night";
    room.phaseEndsAt = Date.now() + NIGHT_DURATION_MS;
    room.dayNumber += 1;
    room.mafiaVotes.clear();
    room.doctorTarget = null;
    room.detectiveActed = false;
    schedulePhaseTimer(room);
  }
  emitRoom(room);
}

function leaveCurrentRoom(socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>): void {
  const pendingDisconnect = disconnectTimers.get(socket.id);
  if (pendingDisconnect) clearTimeout(pendingDisconnect);
  disconnectTimers.delete(socket.id);
  const roomCode = socketRooms.get(socket.id);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socketRooms.delete(socket.id);
  socket.leave(roomCode);
  if (!room) return;

  const leavingPlayer = room.players.find((player) => player.socketId === socket.id);
  room.players = room.players.filter((player) => player.socketId !== socket.id);
  if (leavingPlayer) {
    room.roles.delete(leavingPlayer.id);
    room.mafiaVotes.delete(leavingPlayer.id);
    room.dayVotes.delete(leavingPlayer.id);
    for (const [voterId, targetId] of room.dayVotes) if (targetId === leavingPlayer.id) room.dayVotes.delete(voterId);
  }
  if (room.players.length === 0) {
    clearPhaseTimer(room);
    rooms.delete(roomCode);
    void deleteStoredRoom(roomCode).catch((error: unknown) => console.error("Failed to delete stored room:", error));
    return;
  }
  if (!room.players.some((player) => player.isHost)) {
    room.players[0]!.isHost = true;
    room.players[0]!.ready = false;
  }
  if (room.status === "playing") {
    if (!finishIfWinner(room)) {
      if (room.phase === "night") resolveNight(room);
      else if (room.phase === "day") resolveDay(room);
    }
  } else {
    emitRoom(room);
  }
  if (room.players.length > 0) {
    void saveStoredRoom(room).catch((error: unknown) => console.error("Failed to persist room after player leave:", error));
  }
}

io.on("connection", (socket) => {
  const pendingDisconnect = disconnectTimers.get(socket.id);
  if (pendingDisconnect) clearTimeout(pendingDisconnect);
  disconnectTimers.delete(socket.id);

  if (socket.recovered) {
    const recoveredRoomCode = socketRooms.get(socket.id);
    const recoveredRoom = recoveredRoomCode ? rooms.get(recoveredRoomCode) : undefined;
    if (recoveredRoom) {
      socket.emit("room:updated", snapshot(recoveredRoom));
      const player = recoveredRoom.players.find((item) => item.socketId === socket.id);
      const role = player ? recoveredRoom.roles.get(player.id) : undefined;
      if (role) {
        socket.emit("game:role", role);
        if (role === "mafia") {
          socket.emit("game:mafia-team", recoveredRoom.players
            .filter((player) => recoveredRoom.roles.get(player.id) === "mafia")
            .map((player) => player.id));
        }
      }
    }
  }

  socket.on("room:create", ({ playerName }, callback) => {
    const name = playerName.trim().slice(0, 20);
    if (!name) return callback({ ok: false, error: "Введите имя игрока." });

    leaveCurrentRoom(socket);
    const code = makeRoomCode();
    const token = randomBytes(32).toString("hex");
    const player: RoomPlayer = { id: randomUUID(), socketId: socket.id, reconnectTokenHash: hashReconnectToken(token), name, isHost: true, ready: false, alive: true };
    const room: Room = {
      code, players: [player], createdAt: Date.now(), status: "lobby", phase: null, phaseEndsAt: null, dayNumber: 0,
      winner: null, lastNightMessage: null, lastDayMessage: null, chatMessages: [], dayVotes: new Map(), roles: new Map(), mafiaVotes: new Map(),
      doctorTarget: null, detectiveActed: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: snapshot(room), session: { roomCode: code, playerId: player.id, token } });
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
    const token = randomBytes(32).toString("hex");
    const player: RoomPlayer = { id: randomUUID(), socketId: socket.id, reconnectTokenHash: hashReconnectToken(token), name, isHost: false, ready: false, alive: true };
    room.players.push(player);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: snapshot(room), session: { roomCode: code, playerId: player.id, token } });
    emitRoom(room);
  });

  socket.on("room:rejoin", ({ roomCode, playerId, token }, callback) => {
    const normalizedCode = roomCode.trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    const player = room?.players.find((item) => item.id === playerId);
    if (!room || !player || !tokenMatches(token, player.reconnectTokenHash)) {
      return callback({ ok: false, error: "Не удалось восстановить место. Проверьте, что данные сессии сохранены на этом устройстве." });
    }

    if (player.socketId && player.socketId !== socket.id && io.sockets.sockets.has(player.socketId)) {
      return callback({ ok: false, error: "Эта игровая сессия уже подключена в другом окне." });
    }

    const oldSocketId = player.socketId;
    if (oldSocketId) {
      const pending = disconnectTimers.get(oldSocketId);
      if (pending) clearTimeout(pending);
      disconnectTimers.delete(oldSocketId);
      socketRooms.delete(oldSocketId);
    }

    player.socketId = socket.id;
    socket.join(room.code);
    socketRooms.set(socket.id, room.code);
    socket.emit("room:updated", snapshot(room));
    sendPrivatePlayerState(room, player, socket);
    callback({ ok: true, room: snapshot(room), session: { roomCode: room.code, playerId: player.id, token } });
    void saveStoredRoom(room).catch((error: unknown) => console.error("Failed to persist reconnected player:", error));
  });

  socket.on("room:ready", ({ ready }, callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || room.status !== "lobby") return callback({ ok: false, error: "Нельзя изменить готовность сейчас." });
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
    if (!room.players.every((player) => player.ready)) return callback({ ok: false, error: "Не все игроки готовы." });

    const deck = createRoleDeck(room.players.length);
    room.roles.clear();
    room.players.forEach((player, index) => {
      player.alive = true;
      player.ready = false;
      const role = deck[index]!;
      room.roles.set(player.id, role);
      io.to(player.socketId).emit("game:role", role);
      if (role === "mafia") {
        io.to(player.socketId).emit("game:mafia-team", room.players.filter((member) => deck[room.players.indexOf(member)] === "mafia").map((member) => member.id));
      }
    });
    room.status = "playing";
    room.phase = "night";
    room.phaseEndsAt = Date.now() + NIGHT_DURATION_MS;
    room.dayNumber = 1;
    room.winner = null;
    room.lastNightMessage = null;
    room.lastDayMessage = null;
    room.chatMessages = [];
    room.dayVotes.clear();
    room.mafiaVotes.clear();
    room.doctorTarget = null;
    room.detectiveActed = false;
    schedulePhaseTimer(room);
    emitRoom(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("game:night-action", ({ targetId }, callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || room.status !== "playing" || room.phase !== "night") {
      return callback({ ok: false, error: "Сейчас нельзя совершить ночное действие." });
    }

    const actor = room.players.find((player) => player.socketId === socket.id);
    const target = room.players.find((player) => player.id === targetId && player.alive);
    const role = actor ? room.roles.get(actor.id) : undefined;
    if (!actor || !actor.alive) return callback({ ok: false, error: "Вы не можете действовать: ваш персонаж выбыл." });
    if (!target) return callback({ ok: false, error: "Выбранный игрок недоступен." });
    if (role === "mafia") {
      if (room.mafiaVotes.has(actor.id)) return callback({ ok: false, error: "Вы уже проголосовали этой ночью." });
      if (room.roles.get(target.id) === "mafia") return callback({ ok: false, error: "Мафия не может выбрать своего сообщника." });
      room.mafiaVotes.set(actor.id, target.id);
    } else if (role === "doctor") {
      if (room.doctorTarget !== null) return callback({ ok: false, error: "Вы уже выбрали, кого спасать." });
      room.doctorTarget = target.id;
    } else if (role === "detective") {
      if (room.detectiveActed) return callback({ ok: false, error: "Вы уже провели проверку этой ночью." });
      if (target.id === actor.id) return callback({ ok: false, error: "Нельзя проверить самого себя." });
      room.detectiveActed = true;
      io.to(socket.id).emit("game:investigation-result", {
        targetId: target.id,
        targetName: target.name,
        isMafia: room.roles.get(target.id) === "mafia",
      });
    } else {
      return callback({ ok: false, error: "У вашей роли нет ночного действия." });
    }

    void saveStoredRoom(room).catch((error: unknown) => console.error("Failed to persist night action:", error));
    resolveNight(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("game:day-vote", ({ targetId }, callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || room.status !== "playing" || room.phase !== "day") {
      return callback({ ok: false, error: "Сейчас голосование недоступно." });
    }
    const actor = room.players.find((player) => player.socketId === socket.id);
    const target = room.players.find((player) => player.id === targetId && player.alive);
    if (!actor || !actor.alive) return callback({ ok: false, error: "Вы выбыли и не можете голосовать." });
    if (!target) return callback({ ok: false, error: "Выбранный игрок уже недоступен." });
    if (target.id === actor.id) return callback({ ok: false, error: "Нельзя голосовать за себя." });
    if (room.dayVotes.has(actor.id)) return callback({ ok: false, error: "Вы уже проголосовали." });

    room.dayVotes.set(actor.id, target.id);
    void saveStoredRoom(room).catch((error: unknown) => console.error("Failed to persist day vote:", error));
    resolveDay(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("chat:send", ({ text: rawText }, callback) => {
    const roomCode = socketRooms.get(socket.id);
    const room = roomCode ? rooms.get(roomCode) : undefined;
    if (!room || room.status !== "playing" || room.phase !== "day") return callback({ ok: false, error: "Чат доступен только во время дневного обсуждения." });
    const player = room.players.find((item) => item.socketId === socket.id);
    if (!player || !player.alive) return callback({ ok: false, error: "Выбывшие игроки не могут писать в чат." });
    const messageText = rawText.trim().slice(0, 240);
    if (!messageText) return callback({ ok: false, error: "Сообщение не может быть пустым." });
    const message: ChatMessage = {
      id: `${player.id}-${Date.now()}`,
      playerId: player.id,
      playerName: player.name,
      text: messageText,
      sentAt: Date.now(),
    };
    room.chatMessages.push(message);
    if (room.chatMessages.length > 40) room.chatMessages.shift();
    emitRoom(room);
    callback({ ok: true, room: snapshot(room) });
  });

  socket.on("room:leave", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => {
    if (!socketRooms.has(socket.id)) return;
    const timer = setTimeout(() => {
      disconnectTimers.delete(socket.id);
      leaveCurrentRoom(socket);
    }, DISCONNECT_GRACE_MS);
    disconnectTimers.set(socket.id, timer);
  });
});

async function startServer(): Promise<void> {
  try {
    const restoredRooms = await initializeRoomStorage<Room>();
    for (const room of restoredRooms) {
      rooms.set(room.code, room);
      if (room.status === "playing") schedulePhaseTimer(room);
    }
    if (restoredRooms.length > 0) console.log(`Restored ${restoredRooms.length} room(s) from Redis.`);
  } catch (error) {
    console.error("Redis initialization failed; starting with in-memory rooms:", error);
  }

  httpServer.listen(PORT, () => {
    console.log(`Mafia server listening on port ${PORT}`);
  });
}

void startServer();
