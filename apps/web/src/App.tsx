import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, Check, Copy, Crown, DoorOpen, Moon, Shield, Users } from "lucide-react";
import type { ClientToServerEvents, ServerToClientEvents, RoomSnapshot, Role } from "@mafia/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
type MafiaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ROLE_INFO: Record<Role, { title: string; description: string }> = {
  mafia: { title: "Мафия", description: "Ночью выбирай, кого устранить. Днём скрывай свою личность." },
  doctor: { title: "Доктор", description: "Ночью выбирай игрока, которого хочешь спасти." },
  detective: { title: "Комиссар", description: "Ночью проверяй одного игрока на принадлежность к мафии." },
  citizen: { title: "Мирный житель", description: "Ищи противоречия, обсуждай и голосуй, чтобы найти мафию." },
};

export default function App() {
  const [socket, setSocket] = useState<MafiaSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const connection: MafiaSocket = io(SERVER_URL, { autoConnect: true, reconnection: true });
    connection.on("connect", () => setConnected(true));
    connection.on("disconnect", () => setConnected(false));
    connection.on("room:updated", (nextRoom) => {
      setRoom(nextRoom);
      if (nextRoom.status === "lobby") setRole(null);
    });
    connection.on("game:role", setRole);
    setSocket(connection);
    return () => { connection.disconnect(); };
  }, []);

  const createRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:create", { playerName: name }, (result) => {
      if (result.ok) { setRoom(result.room); setRole(null); }
      else setError(result.error);
    });
  };

  const joinRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:join", { code, playerName: name }, (result) => {
      if (result.ok) { setRoom(result.room); setRole(null); }
      else setError(result.error);
    });
  };

  const leaveRoom = () => {
    socket?.emit("room:leave");
    setRoom(null);
    setRole(null);
    setError("");
  };

  const setReady = (ready: boolean) => {
    if (!socket) return;
    setError("");
    socket.emit("room:ready", { ready }, (result) => {
      if (result.ok) setRoom(result.room);
      else setError(result.error);
    });
  };

  const startGame = () => {
    if (!socket) return;
    setError("");
    socket.emit("game:start", (result) => {
      if (result.ok) setRoom(result.room);
      else setError(result.error);
    });
  };

  const copyCode = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); }
    catch { setError("Не удалось скопировать код. Вы можете выделить его вручную."); }
  };

  const isHost = room?.hostId === socket?.id;
  const allReady = Boolean(room?.players.length && room.players.every((player) => player.ready));
  const canStart = Boolean(isHost && room && room.players.length >= 4 && allReady && room.status === "lobby");

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark"><Moon size={19} /></span> MAFIA</a>
        <div className="connection"><span className={connected ? "status-dot online" : "status-dot"} />{connected ? "Сервер доступен" : "Подключение..."}</div>
      </header>

      {!room ? (
        <section className="landing">
          <div className="eyebrow"><span /> ОНЛАЙН-ИГРА ДЛЯ КОМПАНИИ</div>
          <h1>Ночь скрывает<br /><em>правду.</em></h1>
          <p className="intro">Соберите друзей. Получите тайные роли. Найдите мафию — или не выдайте себя.</p>
          <div className="lobby-card">
            <label htmlFor="player-name">Как вас называть?</label>
            <input id="player-name" maxLength={20} placeholder="Ваше имя" value={name} onChange={(event) => setName(event.target.value)} />
            <button className="primary-button" disabled={!connected || !name.trim()} onClick={createRoom}><Users size={17} /> Создать комнату</button>
            <div className="separator"><span /> ИЛИ ПРИСОЕДИНИТЬСЯ <span /></div>
            <div className="join-row">
              <input aria-label="Код комнаты" maxLength={5} placeholder="КОД" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
              <button className="secondary-button" disabled={!connected || !name.trim() || code.trim().length !== 5} onClick={joinRoom}>Войти <DoorOpen size={16} /></button>
            </div>
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="feature-row">
            <div><Shield size={18} /><span>Тайные роли</span></div>
            <div><Moon size={18} /><span>Автоматические фазы</span></div>
            <div><Users size={18} /><span>Только ваша компания</span></div>
          </div>
        </section>
      ) : (
        <section className="room-view">
          <button className="back-button" onClick={leaveRoom}><ArrowLeft size={16} /> Покинуть комнату</button>
          {room.status === "playing" && role ? (
            <div className="role-reveal">
              <div className="eyebrow"><span /> ВАША ТАЙНАЯ РОЛЬ</div>
              <h1>Вы —<br /><em>{ROLE_INFO[role].title}.</em></h1>
              <div className="role-card">
                <Shield size={28} />
                <p>{ROLE_INFO[role].description}</p>
                <small>Не показывайте эту карточку другим игрокам.</small>
              </div>
              <p className="waiting-note">Роли розданы. Следующий этап — ночные действия и игровой цикл.</p>
            </div>
          ) : room.status === "playing" ? (
            <div className="role-reveal">
              <div className="eyebrow"><span /> ИГРА НАЧАЛАСЬ</div>
              <h1>Получаем<br /><em>роль…</em></h1>
              <p className="waiting-note">Ожидаем приватное сообщение от сервера.</p>
            </div>
          ) : (
            <>
              <div className="eyebrow"><span /> КОМНАТА ОЖИДАНИЯ</div>
              <h1>Собираем<br /><em>компанию.</em></h1>
              <div className="room-code-card">
                <span>КОД ПРИГЛАШЕНИЯ</span>
                <div className="code-line"><strong>{room.code}</strong><button onClick={copyCode} aria-label="Скопировать код"><Copy size={17} /></button></div>
                <p>Отправьте этот код друзьям, чтобы они могли войти.</p>
              </div>
              <div className="players-heading"><span><Users size={17} /> Игроки</span><b>{room.players.length} / 12</b></div>
              <div className="players-list">
                {room.players.map((player, index) => (
                  <div className="player-row" key={player.id}>
                    <div className="player-avatar">{player.name.slice(0, 1).toUpperCase()}</div>
                    <span>{player.name}</span>
                    {player.isHost && <small><Crown size={13} /> СОЗДАТЕЛЬ</small>}
                    <span className={player.ready ? "ready-state is-ready" : "ready-state"}>{player.ready ? "ГОТОВ" : "НЕ ГОТОВ"}</span>
                    <span className="player-number">#{String(index + 1).padStart(2, "0")}</span>
                  </div>
                ))}
              </div>
              <div className="lobby-actions">
                <button className="secondary-button" onClick={() => setReady(!room.players.find((player) => player.id === socket?.id)?.ready)}>
                  <Check size={16} /> {room.players.find((player) => player.id === socket?.id)?.ready ? "Я не готов" : "Я готов"}
                </button>
                {isHost && <button className="primary-button start-button" disabled={!canStart} onClick={startGame}>Начать игру</button>}
              </div>
              <p className="waiting-note">{room.players.length < 4 ? "Для начала нужно минимум 4 игрока." : allReady ? "Все готовы. Создатель может начинать!" : "Ожидаем готовности всех игроков…"}</p>
            </>
          )}
          {error && <p className="error-message">{error}</p>}
        </section>
      )}
      <footer>MAFIA <span>·</span> ДОВЕРЯЙТЕ НЕ ВСЕМ</footer>
    </main>
  );
}
