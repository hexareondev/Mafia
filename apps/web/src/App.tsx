import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, Copy, Crown, DoorOpen, Moon, Shield, Users } from "lucide-react";
import type { ClientToServerEvents, ServerToClientEvents, RoomSnapshot } from "@mafia/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
type MafiaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export default function App() {
  const [socket, setSocket] = useState<MafiaSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const connection: MafiaSocket = io(SERVER_URL, { autoConnect: true, reconnection: true });
    connection.on("connect", () => setConnected(true));
    connection.on("disconnect", () => setConnected(false));
    connection.on("room:updated", setRoom);
    setSocket(connection);
    return () => { connection.disconnect(); };
  }, []);

  const createRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:create", { playerName: name }, (result) => {
      if (result.ok) setRoom(result.room);
      else setError(result.error);
    });
  };

  const joinRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:join", { code, playerName: name }, (result) => {
      if (result.ok) setRoom(result.room);
      else setError(result.error);
    });
  };

  const leaveRoom = () => {
    socket?.emit("room:leave");
    setRoom(null);
  };

  const copyCode = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); }
    catch { setError("Не удалось скопировать код. Вы можете выделить его вручную."); }
  };

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
          <button className="back-button" onClick={leaveRoom}><ArrowLeft size={16} /> На главную</button>
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
                <span className="player-number">#{String(index + 1).padStart(2, "0")}</span>
              </div>
            ))}
          </div>
          <p className="waiting-note">Ожидаем друзей… Запуск игры добавим на следующем этапе.</p>
          {error && <p className="error-message">{error}</p>}
        </section>
      )}
      <footer>MAFIA <span>·</span> ДОВЕРЯЙТЕ НЕ ВСЕМ</footer>
    </main>
  );
}
