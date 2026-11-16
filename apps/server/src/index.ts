import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
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

type RoomPlayer = PlayerSummary & { socketId: string };
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
  return room.players.filter((player) => player.alive && (!role || room.roles.get(player.socketId) === role)).length;
}

function checkWinner(room: Room): GameWinner | null {
  const aliveRoles = room.players
    .filter((player) => player.alive)
    .map((player) => room.roles.get(player.socketId))
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
  const livingMafia = room.players.filter((player) => player.alive && room.roles.get(player.socketId) === "mafia");
  const doctorAlive = countAlive(room, "doctor") > 0;
  const detectiveAlive = countAlive(room, "detective") > 0;
  return livingMafia.every((player) => room.mafiaVotes.has(player.socketId))
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
  if (!timedOut && !livingPlayers.every((player) => room.dayVotes.has(player.socketId))) return;
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

  room.players = room.players.filter((player) => player.socketId !== socket.id);
  room.roles.delete(socket.id);
  room.mafiaVotes.delete(socket.id);
  room.dayVotes.delete(socket.id);
  for (const [voterId, targetId] of room.dayVotes) if (targetId === socket.id) room.dayVotes.delete(voterId);
  if (room.players.length === 0) {
    clearPhaseTimer(room);
    rooms.delete(roomCode);
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
      const role = recoveredRoom.roles.get(socket.id);
      if (role) {
        socket.emit("game:role", role);
        if (role === "mafia") {
          socket.emit("game:mafia-team", recoveredRoom.players
            .filter((player) => recoveredRoom.roles.get(player.socketId) === "mafia")
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
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: true, ready: false, alive: true };
    const room: Room = {
      code, players: [player], createdAt: Date.now(), status: "lobby", phase: null, phaseEndsAt: null, dayNumber: 0,
      winner: null, lastNightMessage: null, lastDayMessage: null, chatMessages: [], dayVotes: new Map(), roles: new Map(), mafiaVotes: new Map(),
      doctorTarget: null, detectiveActed: false,
    };
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
    const player: RoomPlayer = { id: socket.id, socketId: socket.id, name, isHost: false, ready: false, alive: true };
    room.players.push(player);
    socket.join(code);
    socketRooms.set(socket.id, code);
    callback({ ok: true, room: snapshot(room) });
    emitRoom(room);
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
      room.roles.set(player.socketId, role);
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
    const role = room.roles.get(socket.id);
    if (!actor || !actor.alive) return callback({ ok: false, error: "Вы не можете действовать: ваш персонаж выбыл." });
    if (!target) return callback({ ok: false, error: "Выбранный игрок недоступен." });
    if (role === "mafia") {
      if (room.mafiaVotes.has(socket.id)) return callback({ ok: false, error: "Вы уже проголосовали этой ночью." });
      if (room.roles.get(target.socketId) === "mafia") return callback({ ok: false, error: "Мафия не может выбрать своего сообщника." });
      room.mafiaVotes.set(socket.id, target.id);
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
        isMafia: room.roles.get(target.socketId) === "mafia",
      });
    } else {
      return callback({ ok: false, error: "У вашей роли нет ночного действия." });
    }

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
    if (room.dayVotes.has(socket.id)) return callback({ ok: false, error: "Вы уже проголосовали." });

    room.dayVotes.set(socket.id, target.id);
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
      id: `${socket.id}-${Date.now()}`,
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

httpServer.listen(PORT, () => {
  console.log(`Mafia server listening on port ${PORT}`);
});
