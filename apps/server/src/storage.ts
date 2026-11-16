import { createClient } from "redis";

const REDIS_PREFIX = "mafia:room:";
const ROOM_TTL_SECONDS = 7 * 24 * 60 * 60;

type PersistableRoom = {
  code: string;
  dayVotes: Map<string, string>;
  roles: Map<string, string>;
  mafiaVotes: Map<string, string>;
  [key: string]: unknown;
};

let client: ReturnType<typeof createClient> | null = null;
let enabled = false;
const writeQueues = new Map<string, Promise<void>>();

export async function initializeRoomStorage<T extends PersistableRoom>(): Promise<T[]> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("REDIS_URL is not set; room storage is in-memory only.");
    return [];
  }

  const redis = createClient({ url });
  redis.on("error", (error) => console.error("Redis client error:", error));
  await redis.connect();
  client = redis;
  enabled = true;

  const restored: T[] = [];
  for await (const key of redis.scanIterator({ MATCH: `${REDIS_PREFIX}*`, COUNT: 100 })) {
    const serialized = await redis.get(key);
    if (!serialized) continue;
    try {
      const parsed = JSON.parse(serialized) as Omit<T, "dayVotes" | "roles" | "mafiaVotes"> & {
        dayVotes: [string, string][];
        roles: [string, string][];
        mafiaVotes: [string, string][];
      };
      restored.push({
        ...parsed,
        dayVotes: new Map(parsed.dayVotes),
        roles: new Map(parsed.roles),
        mafiaVotes: new Map(parsed.mafiaVotes),
      } as T);
    } catch (error) {
      console.error(`Skipping invalid saved room ${key}:`, error);
    }
  }
  return restored;
}

export function saveStoredRoom(room: PersistableRoom): Promise<void> {
  if (!enabled || !client) return Promise.resolve();

  const previous = writeQueues.get(room.code) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const serialized = JSON.stringify({
      ...room,
      dayVotes: [...room.dayVotes.entries()],
      roles: [...room.roles.entries()],
      mafiaVotes: [...room.mafiaVotes.entries()],
    });
    await client!.set(`${REDIS_PREFIX}${room.code}`, serialized, { EX: ROOM_TTL_SECONDS });
  });
  writeQueues.set(room.code, next);
  void next.finally(() => {
    if (writeQueues.get(room.code) === next) writeQueues.delete(room.code);
  });
  return next;
}

export async function deleteStoredRoom(code: string): Promise<void> {
  const pending = writeQueues.get(code);
  if (pending) await pending.catch(() => undefined);
  if (enabled && client) await client.del(`${REDIS_PREFIX}${code}`);
}
