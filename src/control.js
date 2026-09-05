// One strongly consistent object holds aggregate counters and explicitly shared
// reports. It never receives raw fetched HTML, visitor IPs, or request headers.
export const REPORT_TTL_MS = 7 * 86400000;
export const ID_PATTERN = /^[a-f0-9]{32}$/;

export function configuredLimit(value) {
  const parsed = Number(value ?? 250);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : 250;
}

const reply = (body, status = 200) => Response.json(body, {status});
const dateKey = (now) => `day:${new Date(now).toISOString().slice(0, 10)}`;

export class Control {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    if (path === '/reserve' && request.method === 'POST') {
      const accepted = await this.state.storage.transaction(async txn => {
        const key = dateKey(now);
        const day = await txn.get(key) || {started: 0, completed: 0, failed: 0, shared: 0, deleted: 0};
        if (day.started >= configuredLimit(this.env.DAILY_SCAN_LIMIT)) return false;
        day.started++; await txn.put(key, day); return true;
      });
      return reply({accepted}, accepted ? 200 : 429);
    }
    if (path === '/event' && request.method === 'POST') {
      const {event} = await request.json();
      if (!['completed', 'failed', 'deleted'].includes(event)) return reply({ok: false}, 400);
      await this.state.storage.transaction(async txn => {
        const key = dateKey(now);
        const day = await txn.get(key) || {started: 0, completed: 0, failed: 0, shared: 0, deleted: 0};
        day[event]++; await txn.put(key, day);
      });
      return reply({ok: true});
    }
    if (path === '/reports' && request.method === 'POST') {
      const {id, report, deleteHash} = await request.json();
      if (!ID_PATTERN.test(id) || !/^[a-f0-9]{64}$/.test(deleteHash)) return reply({ok: false}, 400);
      const expires = now + REPORT_TTL_MS;
      const stored = await this.state.storage.transaction(async txn => {
        const key = dateKey(now);
        const day = await txn.get(key) || {started: 0, completed: 0, failed: 0, shared: 0, deleted: 0};
        if (day.shared >= configuredLimit(this.env.DAILY_SCAN_LIMIT)) return false;
        if (await txn.get(`report:${id}`)) return false;
        await txn.put(`report:${id}`, {report, deleteHash, expiresAt: new Date(expires).toISOString()});
        await txn.put(`expires:${expires}:${id}`, true);
        day.shared++; await txn.put(key, day);
        const alarm = await txn.getAlarm();
        if (!alarm || alarm > expires) await txn.setAlarm(expires);
        return true;
      });
      return reply({ok: stored, expiresAt: new Date(expires).toISOString()}, stored ? 201 : 429);
    }
    const match = /^\/reports\/([a-f0-9]{32})$/.exec(path);
    if (match && ['GET', 'DELETE'].includes(request.method)) {
      const key = `report:${match[1]}`;
      // A transaction prevents a GET racing past a completed deletion.
      return this.state.storage.transaction(async txn => {
        const record = await txn.get(key);
        if (!record) return reply({ok: false}, 404);
        const expires = Date.parse(record.expiresAt);
        if (expires <= now) {
          await txn.delete([key, `expires:${expires}:${match[1]}`]);
          return reply({ok: false}, 410);
        }
        if (request.method === 'GET') return reply({ok: true, report: record.report, expiresAt: record.expiresAt});
        const supplied = request.headers.get('x-delete-hash') || '';
        if (!constantTimeEqual(supplied, record.deleteHash)) return reply({ok: false}, 403);
        await txn.delete([key, `expires:${expires}:${match[1]}`]);
        return reply({ok: true});
      });
    }
    if (path === '/stats' && request.method === 'GET') {
      const days = await this.state.storage.list({prefix: 'day:', reverse: true, limit: 8});
      return reply({asOf: new Date(now).toISOString(), dailyScanLimit: configuredLimit(this.env.DAILY_SCAN_LIMIT),
        days: [...days].map(([key, counts]) => ({date: key.slice(4), ...counts}))});
    }
    return reply({ok: false}, 404);
  }

  async alarm() {
    const now = Date.now();
    const expiries = await this.state.storage.list({prefix: 'expires:', limit: 100});
    for (const [key] of expiries) {
      const [, epoch, id] = key.split(':');
      if (Number(epoch) > now) break;
      await this.state.storage.delete([key, `report:${id}`]);
    }
    const next = await this.state.storage.list({prefix: 'expires:', limit: 1});
    if (next.size) await this.state.storage.setAlarm(Math.max(now + 1000, Number([...next.keys()][0].split(':')[1])));
    const oldDays = await this.state.storage.list({prefix: 'day:'});
    for (const [key] of oldDays) if (Date.parse(key.slice(4)) < now - 8 * 86400000) await this.state.storage.delete(key);
  }
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
