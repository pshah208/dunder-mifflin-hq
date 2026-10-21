import { randomUUID } from "node:crypto";

export const MAX_QUEUED_MESSAGES = 20;

// Mutations commit to disk before becoming visible. Restored queues require explicit resume.
export function createMessageQueue({ read, write, max = MAX_QUEUED_MESSAGES }) {
  const slots = new Map(), locks = new Map();
  const load = async sid => {
    if (slots.has(sid)) return slots.get(sid);
    const saved = await read(sid);
    const value = saved ? {
      ...saved,
      paused: saved.items.length > 0 || saved.paused,
      reason: saved.items.length ? "HQ restarted. Review queued requests and resume explicitly." : saved.reason,
      items: saved.items.map(item => ({ ...item, status: item.status === "starting" ? "uncertain" : item.status })),
    } : { items: [], paused: false, reason: null };
    slots.set(sid, value);
    return value;
  };
  const serial = (sid, operation) => {
    const previous = locks.get(sid) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const draft = structuredClone(await load(sid));
      const result = operation(draft);
      await write(sid, draft);
      slots.set(sid, draft);
      return result;
    });
    locks.set(sid, next);
    void next.finally(() => { if (locks.get(sid) === next) locks.delete(sid); }).catch(() => {});
    return next;
  };
  return {
    async get(sid) {
      await locks.get(sid)?.catch(() => {});
      return structuredClone(await load(sid));
    },
    enqueue(sid, args) {
      return serial(sid, q => {
        if (q.items.length >= max) throw Object.assign(new Error(`Queue is full (max ${max} messages).`), { status: 429 });
        const item = { ...args, queueId: randomUUID(), queuedAt: new Date().toISOString(), status: "pending" };
        q.items.push(item);
        return item;
      });
    },
    claim(sid) {
      return serial(sid, q => {
        if (q.paused || !q.items.length || q.items[0].status !== "pending") return null;
        q.items[0].status = "starting";
        return structuredClone(q.items[0]);
      });
    },
    complete(sid, id) {
      return serial(sid, q => { q.items = q.items.filter(item => item.queueId !== id); });
    },
    fail(sid, id, reason) {
      return serial(sid, q => {
        const item = q.items.find(item => item.queueId === id);
        if (item) item.status = "pending";
        q.paused = true; q.reason = reason;
      });
    },
    pause(sid, reason) {
      return serial(sid, q => { q.paused = true; q.reason = reason; });
    },
    resume(sid) {
      return serial(sid, q => {
        if (q.items.some(item => item.status === "uncertain"))
          throw Object.assign(new Error("A request may have started before restart. Check history and remove it before resuming to avoid duplicate actions."), { status: 409 });
        q.paused = false; q.reason = null;
      });
    },
    remove(sid, id) {
      return serial(sid, q => {
        const item = q.items.find(item => item.queueId === id);
        if (!item) throw Object.assign(new Error("Queued message not found."), { status: 404 });
        if (item.status === "starting") throw Object.assign(new Error("Request is starting; use Stop instead."), { status: 409 });
        q.items = q.items.filter(item => item.queueId !== id);
      });
    },
    clear(sid) { return serial(sid, q => { q.items = []; q.paused = true; q.reason = null; }); },
  };
}

export function publicQueue(q) {
  return {
    paused: q.paused, reason: q.reason, max: MAX_QUEUED_MESSAGES,
    items: q.items.map(item => ({
      queueId: item.queueId, queuedAt: item.queuedAt, status: item.status,
      message: item.message, mode: item.mode, speed: item.speed || "auto",
      attachmentCount: item.attachmentIds?.length || 0,
    })),
  };
}
