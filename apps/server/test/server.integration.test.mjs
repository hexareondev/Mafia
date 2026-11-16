import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { io as createClient } from "socket.io-client";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForEvent(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

function emitWithAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No acknowledgement for ${event}`)), 5000);
    socket.emit(event, ...args, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function connectClient(url) {
  const socket = createClient(url, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 5000,
  });
  await once(socket, "connect");
  return socket;
}

test("four clients can complete a full server-authoritative game", async (t) => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const server = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      CLIENT_ORIGINS: url,
      NIGHT_DURATION_SECONDS: "30",
      DAY_DURATION_SECONDS: "30",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.disconnect();
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), wait(1500)]);
  });

  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await wait(100);
  }
  assert.equal(healthy, true, `server did not start. Output: ${serverOutput}`);

  for (let index = 0; index < 4; index += 1) {
    clients.push(await connectClient(url));
  }

  const created = await emitWithAck(clients[0], "room:create", { playerName: "Host" });
  assert.equal(created.ok, true);
  assert.ok(created.session?.token);
  const sessions = [created.session];
  const roomCode = created.room.code;

  for (let index = 1; index < 4; index += 1) {
    const joined = await emitWithAck(clients[index], "room:join", {
      code: roomCode,
      playerName: `Player ${index + 1}`,
    });
    assert.equal(joined.ok, true);
    assert.ok(joined.session?.token);
    sessions.push(joined.session);
  }

  for (const client of clients) {
    const ready = await emitWithAck(client, "room:ready", { ready: true });
    assert.equal(ready.ok, true);
  }

  const rolePromises = clients.map((client) => waitForEvent(client, "game:role"));
  const started = await emitWithAck(clients[0], "game:start");
  assert.equal(started.ok, true);
  const roles = await Promise.all(rolePromises);
  assert.equal(roles.length, 4);
  assert.equal(roles.filter((role) => role === "mafia").length, 1);
  assert.equal(roles.filter((role) => role === "doctor").length, 1);
  assert.equal(roles.filter((role) => role === "detective").length, 1);

  const oldHostSocket = clients[0];
  oldHostSocket.disconnect();
  const replacementHostSocket = await connectClient(url);
  clients[0] = replacementHostSocket;
  const restoredRolePromise = waitForEvent(replacementHostSocket, "game:role");
  const rejoined = await emitWithAck(replacementHostSocket, "room:rejoin", sessions[0]);
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.room.players[0].id, created.room.players[0].id);
  assert.equal(await restoredRolePromise, roles[0]);

  // Public room snapshots must never reveal any player's role.
  assert.equal("roles" in started.room, false);
  assert.equal(started.room.phase, "night");
  assert.ok(started.room.phaseEndsAt > Date.now());

  const mafiaIndex = roles.indexOf("mafia");
  const doctorIndex = roles.indexOf("doctor");
  const detectiveIndex = roles.indexOf("detective");
  const mafiaId = started.room.players[mafiaIndex].id;
  const townTargetId = started.room.players.find((player) => player.id !== mafiaId).id;

  const investigationResult = waitForEvent(clients[detectiveIndex], "game:investigation-result");
  const dayStarted = waitForEvent(
    clients[0],
    "room:updated",
    (room) => room.phase === "day",
  );

  const mafiaAction = emitWithAck(clients[mafiaIndex], "game:night-action", { targetId: townTargetId });
  const doctorAction = emitWithAck(clients[doctorIndex], "game:night-action", { targetId: townTargetId });
  const detectiveTargetId = started.room.players.find((player) => player.id !== started.room.players[detectiveIndex].id).id;
  const detectiveAction = emitWithAck(clients[detectiveIndex], "game:night-action", { targetId: detectiveTargetId });
  const nightResults = await Promise.all([mafiaAction, doctorAction, detectiveAction]);
  assert.ok(nightResults.every((result) => result.ok));
  const checkedPlayer = await investigationResult;
  assert.equal(typeof checkedPlayer.isMafia, "boolean");
  const dayRoom = await dayStarted;
  assert.match(dayRoom.lastNightMessage, /доктор спас/);
  assert.equal(dayRoom.phase, "day");

  const winnerUpdate = waitForEvent(
    clients[0],
    "room:updated",
    (room) => room.status === "finished",
  );
  const votes = clients.map((client, index) => {
    const targetId = roles[index] === "mafia"
      ? started.room.players.find((player) => player.id !== mafiaId).id
      : mafiaId;
    return emitWithAck(client, "game:day-vote", { targetId });
  });
  const voteResults = await Promise.all(votes);
  assert.ok(voteResults.every((result) => result.ok));
  const finishedRoom = await winnerUpdate;
  assert.equal(finishedRoom.status, "finished");
  assert.equal(finishedRoom.winner, "town");
  assert.equal(finishedRoom.players.find((player) => player.id === mafiaId).alive, false);
});
