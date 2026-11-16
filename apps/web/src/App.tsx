import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, Check, Copy, Crown, DoorOpen, MessageCircle, Moon, Send, Shield, Users } from "lucide-react";
import type { ClientToServerEvents, ServerToClientEvents, RoomSnapshot, Role, PlayerSession } from "@mafia/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
type MafiaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const SESSION_STORAGE_KEY = "mafia.playerSession";
const inviteCodeFromUrl = new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() ?? "";

function readStoredSession(): PlayerSession | null {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as PlayerSession;
    return parsed && typeof parsed.roomCode === "string" && typeof parsed.playerId === "string" && typeof parsed.token === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function formatTime(endsAt: number | null, now: number): string {
  if (endsAt === null) return "--:--";
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

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
  const [code, setCode] = useState(inviteCodeFromUrl);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [session, setSession] = useState<PlayerSession | null>(() => readStoredSession());
  const activeRoomRef = useRef<RoomSnapshot | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [investigationResult, setInvestigationResult] = useState<{ targetId: string; targetName: string; isMafia: boolean } | null>(null);
  const [mafiaTeamIds, setMafiaTeamIds] = useState<string[]>([]);
  const [nightActionSubmitted, setNightActionSubmitted] = useState(false);
  const [dayVoteSubmitted, setDayVoteSubmitted] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [error, setError] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    activeRoomRef.current = room;
  }, [room]);

  useEffect(() => {
    const connection: MafiaSocket = io(SERVER_URL, { autoConnect: true, reconnection: true });
    connection.on("connect", () => {
      setConnected(true);
      if (!connection.recovered) {
        const savedSession = readStoredSession();
        if (savedSession && !inviteCodeFromUrl) {
          connection.emit("room:rejoin", savedSession, (result) => {
            if (result.ok) {
              const nextSession = result.session ?? savedSession;
              localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
              setSession(nextSession);
              setRoom(result.room);
              activeRoomRef.current = result.room;
              setError("");
            } else {
              localStorage.removeItem(SESSION_STORAGE_KEY);
              setSession(null);
              setRoom(null);
              activeRoomRef.current = null;
              setRole(null);
              setError(result.error);
            }
          });
        } else if (activeRoomRef.current) {
          setRoom(null);
          activeRoomRef.current = null;
          setRole(null);
          setInvestigationResult(null);
          setMafiaTeamIds([]);
          setError("Соединение восстановлено, но игровую сессию вернуть не удалось. Подключитесь к комнате заново.");
        }
      }
    });
    connection.on("disconnect", () => setConnected(false));
    connection.on("room:updated", (nextRoom) => {
      setRoom(nextRoom);
      if (nextRoom.status === "lobby") setRole(null);
    });
    connection.on("game:role", setRole);
    connection.on("game:mafia-team", setMafiaTeamIds);
    connection.on("game:investigation-result", setInvestigationResult);
    setSocket(connection);
    return () => { connection.disconnect(); };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (room?.phase === "night") setNightActionSubmitted(false);
    if (room?.phase === "day") setDayVoteSubmitted(false);
  }, [room?.phase, room?.dayNumber]);

  const createRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:create", { playerName: name }, (result) => {
      if (result.ok) { setRoom(result.room); setRole(null); setInvestigationResult(null); setMafiaTeamIds([]); setNightActionSubmitted(false); if (result.session) { setSession(result.session); localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(result.session)); } }
      else setError(result.error);
    });
  };

  const joinRoom = () => {
    if (!socket) return;
    setError("");
    socket.emit("room:join", { code, playerName: name }, (result) => {
      if (result.ok) { setRoom(result.room); setRole(null); window.history.replaceState({}, "", window.location.pathname); if (result.session) { setSession(result.session); localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(result.session)); } }
      else setError(result.error);
    });
  };

  const leaveRoom = () => {
    socket?.emit("room:leave");
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
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

  const performNightAction = (targetId: string) => {
    if (!socket) return;
    setError("");
    socket.emit("game:night-action", { targetId }, (result) => {
      if (result.ok) { setRoom(result.room); setNightActionSubmitted(true); }
      else setError(result.error);
    });
  };

  const voteDay = (targetId: string) => {
    if (!socket) return;
    setError("");
    socket.emit("game:day-vote", { targetId }, (result) => {
      if (result.ok) { setRoom(result.room); setDayVoteSubmitted(true); }
      else setError(result.error);
    });
  };

  const sendChatMessage = () => {
    if (!socket || !chatDraft.trim()) return;
    setError("");
    socket.emit("chat:send", { text: chatDraft }, (result) => {
      if (result.ok) { setRoom(result.room); setChatDraft(""); }
      else setError(result.error);
    });
  };

  const copyRoomCode = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); }
    catch { setError("Не удалось скопировать код. Вы можете выделить его вручную."); }
  };

  const copyInviteLink = async () => {
    if (!room) return;
    const inviteUrl = new URL(window.location.pathname, window.location.origin);
    inviteUrl.searchParams.set("room", room.code);
    try { await navigator.clipboard.writeText(inviteUrl.toString()); }
    catch { setError("Не удалось скопировать ссылку. Попробуйте скопировать её вручную."); }
  };

  const isHost = room?.hostId === session?.playerId;
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
            {!inviteCodeFromUrl && <button className="primary-button" disabled={!connected || !name.trim()} onClick={createRoom}><Users size={17} /> Создать комнату</button>}
            {!inviteCodeFromUrl && <div className="separator"><span /> ИЛИ ПРИСОЕДИНИТЬСЯ <span /></div>}
            {inviteCodeFromUrl && <p className="invite-hint">Вас пригласили в комнату. Введите ник, чтобы присоединиться.</p>}
            <div className="join-row">
              <input aria-label="Код комнаты" maxLength={5} placeholder="КОД" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
              <button className="secondary-button" disabled={!connected || !name.trim() || code.trim().length !== 5} onClick={joinRoom}>{inviteCodeFromUrl ? "Войти в комнату" : "Войти"} <DoorOpen size={16} /></button>
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
          {room.status === "finished" ? (
            <div className="role-reveal">
              <div className="eyebrow"><span /> ПАРТИЯ ЗАВЕРШЕНА</div>
              <h1>Победа<br /><em>{room.winner === "town" ? "города." : "мафии."}</em></h1>
              <div className="role-card">
                <Shield size={28} />
                <p>{room.winner === "town" ? "Все мафиози выбыли. Город победил!" : "Мафия сравнялась числом с мирными жителями или превзошла их."}</p>
              </div>
              <p className="waiting-note">Чтобы сыграть снова, создайте новую комнату.</p>
            </div>
          ) : room.status === "playing" && role ? (
            <div className="role-reveal">
              <div className="eyebrow"><span /> ВАША ТАЙНАЯ РОЛЬ</div>
              <h1>Вы —<br /><em>{ROLE_INFO[role].title}.</em></h1>
              <div className="role-card">
                <Shield size={28} />
                <p>{ROLE_INFO[role].description}</p>
                <small>Не показывайте эту карточку другим игрокам.</small>
                {role === "mafia" && <small className="mafia-allies">Союзники: {room.players.filter((player) => mafiaTeamIds.includes(player.id)).map((player) => player.name).join(", ")}</small>}
              </div>
              {room.phase === "night" ? (
                <section className="game-panel">
                  <div className="phase-label"><Moon size={16} /> НОЧЬ {room.dayNumber}<span className="phase-timer">{formatTime(room.phaseEndsAt, clockNow)}</span></div>
                  <h2>Город засыпает</h2>
                  {room.players.find((player) => player.id === session?.playerId)?.alive ? (
                    role === "citizen" ? (
                      <p className="waiting-note">У мирного жителя нет ночного действия. Ожидайте рассвета.</p>
                    ) : (
                      <>
                        <p className="game-hint">{role === "mafia" ? "Выберите игрока для устранения. Если мафиози несколько, решение будет принято по большинству голосов." : role === "doctor" ? "Выберите игрока, которого хотите защитить этой ночью. Можно спасти и себя." : "Выберите игрока для тайной проверки. Результат увидите только вы."}</p>
                        <div className="target-list">
                          {room.players.filter((player) => player.alive && (role !== "detective" || player.id !== session?.playerId) && (role !== "mafia" || !mafiaTeamIds.includes(player.id))).map((player) => (
                            <button className="target-button" key={player.id} disabled={nightActionSubmitted} onClick={() => performNightAction(player.id)}>{player.name}<span>{nightActionSubmitted ? "Ход принят" : "Выбрать"}</span></button>
                          ))}
                        </div>
                      </>
                    )
                  ) : <p className="waiting-note">Вы выбыли и больше не можете совершать действия.</p>}
                  {investigationResult && <div className="investigation-result"><strong>Результат проверки</strong><span>{investigationResult.targetName}: {investigationResult.isMafia ? "мафия" : "не мафия"}</span></div>}
                  {room.lastDayMessage && <p className="day-result">{room.lastDayMessage}</p>}
                  <p className="waiting-note">Ночь закончится, когда все живые мафия, доктор и комиссар выполнят свои действия.</p>
                </section>
              ) : (
                <section className="game-panel">
                  <div className="phase-label"><Users size={16} /> ДЕНЬ {room.dayNumber}<span className="phase-timer">{formatTime(room.phaseEndsAt, clockNow)}</span></div>
                  <h2>Город просыпается</h2>
                  <p className="day-result">{room.lastNightMessage ?? "Этой ночью никто не погиб."}</p>
                  {room.players.find((player) => player.id === session?.playerId)?.alive ? (
                    <>
                    <div className="discussion-panel">
                      <div className="discussion-heading"><MessageCircle size={15} /> Обсуждение</div>
                      <div className="chat-messages">
                        {room.chatMessages.map((message) => <div className={message.playerId === session?.playerId ? "chat-message own-message" : "chat-message"} key={message.id}><strong>{message.playerName}</strong><span>{message.text}</span></div>)}
                        {!room.chatMessages.length && <p className="chat-empty">Пока сообщений нет. Начните обсуждение.</p>}
                      </div>
                      <div className="chat-compose">
                        <input maxLength={240} value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendChatMessage(); }} placeholder="Ваше сообщение..." />
                        <button onClick={sendChatMessage} disabled={!chatDraft.trim()} aria-label="Отправить сообщение"><Send size={16} /></button>
                      </div>
                    </div>
                    <div className="vote-panel">
                      <strong>Голосование</strong>
                      <p>{dayVoteSubmitted ? "Ваш голос принят. Ожидаем остальных игроков." : "Выберите игрока, которого считаете мафией. Свой голос изменить нельзя."}</p>
                      <div className="target-list">
                        {room.players.filter((player) => player.alive && player.id !== session?.playerId).map((player) => <button className="target-button" key={player.id} disabled={dayVoteSubmitted} onClick={() => voteDay(player.id)}>{player.name}<span>{dayVoteSubmitted ? "Голос принят" : "Голосовать"}</span></button>)}
                      </div>
                    </div>
                    </>
                  ) : <p className="waiting-note">Вы выбыли. Вы можете наблюдать за игрой, но не можете писать и голосовать.</p>}
                </section>
              )}
              <div className="game-roster">
                <strong>Игроки</strong>
                {room.players.map((player) => <div className={player.alive ? "game-player" : "game-player is-dead"} key={player.id}><span>{player.name}</span><small>{player.alive ? "В игре" : "Выбыл"}</small></div>)}
              </div>
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
                <div className="code-line"><strong>{room.code}</strong><div className="code-actions"><button onClick={copyRoomCode} aria-label="Скопировать код" title="Скопировать код"><Copy size={17} /></button><button onClick={copyInviteLink} aria-label="Скопировать ссылку-приглашение" title="Скопировать ссылку-приглашение"><DoorOpen size={17} /></button></div></div>
                <p>Скопируйте код или ссылку — по ссылке друзьям останется только ввести ник.</p>
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
                <button className="secondary-button" onClick={() => setReady(!room.players.find((player) => player.id === session?.playerId)?.ready)}>
                  <Check size={16} /> {room.players.find((player) => player.id === session?.playerId)?.ready ? "Я не готов" : "Я готов"}
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
