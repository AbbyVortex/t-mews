import {createHmac} from 'node:crypto';
import {createSocket} from 'node:dgram';
import {lookup} from 'node:dns/promises';
import type {RadarSignal} from '../radar-watch.ts';

const repository = 'AbbyVortex/t-mews';
const base = 'https://api.github.com/repos/' + repository;
const gateTag = 'kinoko-radar-private-gate';
const markerPrefix = 'KINOKO-RADAR';
const validId = (s: unknown): s is string => typeof s === 'string' && /^(?:x:\d{1,20}|(?:url|hash):[0-9a-f]{64})$/.test(s);
const timestamp = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const episodeId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
const freshnessMs = 30 * 60_000;

interface Config {releaseId: number; host: string; port: number; mac: Buffer; key: Buffer}
interface Claim {
  id: string; episode: string; sentAt: number; phase: 'claimed';
  signal?: [RadarSignal['kind'], number, number, number | null];
}
interface Gate {state: 'awake'|'sleeping'; episode: string; at: number; watchActive: boolean; signalId?: string | null}

function configFrom(raw: string): Config {
  const c = JSON.parse(raw);
  if (!Number.isSafeInteger(c?.releaseId) || c.releaseId < 1 || typeof c.host !== 'string'
    || c.host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(c.host) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535
    || typeof c.mac !== 'string' || typeof c.key !== 'string') throw Error('invalid_radar_config');
  const mac = c.mac.replace(/[:-]/g,'');
  const key = Buffer.from(c.key,'base64');
  if (!/^[a-fA-F0-9]{12}$/.test(mac) || key.length !== 32 || key.toString('base64') !== c.key) throw Error('invalid_radar_config');
  return {releaseId:c.releaseId,host:c.host,port:c.port,mac:Buffer.from(mac,'hex'),key};
}

function signalTime(s: RadarSignal): number {
  if (s?.version !== 1 || !validId(s.id) || !['announcement','hint'].includes(s.kind)
    || !timestamp(s.publishedAt) || !timestamp(s.observedAt) || s.publishedAt > s.observedAt + 60_000
    || (s.dueAt != null && (!timestamp(s.dueAt) || s.dueAt <= s.observedAt))) throw Error('invalid_radar_signal');
  return s.dueAt ?? s.observedAt;
}

function releaseGate(data: any, releaseId: number): {gate: Gate; name: string; claim?: Claim} {
  if (data?.id !== releaseId || data.draft !== true || data.tag_name !== gateTag
    || typeof data.body !== 'string' || typeof data.name !== 'string') throw Error('invalid_radar_release');
  const gate = JSON.parse(data.body);
  if (gate?.version !== 1 || !['awake','sleeping'].includes(gate.state) || !timestamp(gate.at)
    || (gate.state === 'sleeping' && !episodeId(gate.episode)) || typeof gate.watchActive !== 'boolean'
    || (gate.signalId != null && !validId(gate.signalId))) throw Error('invalid_sleep_state');
  if (data.name === markerPrefix) return {gate,name:data.name};
  if (!data.name.startsWith(markerPrefix+' ')) throw Error('invalid_radar_claim');
  const claim = JSON.parse(data.name.slice(markerPrefix.length+1));
  if (!validId(claim?.id) || !episodeId(claim.episode) || !timestamp(claim.sentAt) || claim.phase !== 'claimed') throw Error('invalid_radar_claim');
  return {gate,name:data.name,claim};
}

function armed(gate: Gate, signal: RadarSignal, due: number, now: number): boolean {
  const freshDevelopment = signal.kind === 'announcement' || signal.dueAt != null;
  return gate.state === 'sleeping' && (!gate.watchActive || freshDevelopment) && gate.signalId !== signal.id
    && gate.at <= due && due <= now && now - due <= freshnessMs;
}

async function sendOnce(payload: Buffer, port: number, address: string): Promise<void> {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve,reject) => {
      socket.once('error',reject);
      socket.send(payload,port,address,error=>error?reject(error):resolve());
    });
  } finally {socket.close();}
}

export async function dispatchRadarWake(env: Record<string,string|undefined>, {
  fetcher = fetch, now = Date.now, resolveAddress = async (host: string) => (await lookup(host,{family:4})).address, send = sendOnce
} = {}): Promise<boolean> {
  if (!env.KINOKO_RADAR_WAKE || env.OPERATION !== 'monitor' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_REPOSITORY?.toLowerCase() !== repository.toLowerCase()) return false;
  if (!env.GITHUB_TOKEN) throw Error('missing_radar_token');
  const config = configFrom(env.KINOKO_RADAR_WAKE);
  const api = async (path:string, init:RequestInit={}) => fetcher(base+path,{
    redirect:'error',signal:AbortSignal.timeout(8000),...init,
    headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache',...init.headers}
  });
  const source = await api('/contents/radar-watch.json?ref=monitor-state',{headers:{Accept:'application/vnd.github.raw+json'}});
  if (source.status === 404) return false;
  if (!source.ok) throw Error('radar_signal_unavailable');
  const signal:RadarSignal = await source.json() as RadarSignal;
  const due = signalTime(signal);
  if (now() < due || now() - due > freshnessMs) return false;

  const path='/releases/'+config.releaseId;
  const readGate = async () => {
    const r=await api(path);
    if (!r.ok) throw Error('radar_gate_unavailable');
    return {...releaseGate(await r.json(),config.releaseId),etag:r.headers.get('etag')};
  };
  const before=await readGate();
  if (!armed(before.gate,signal,due,now()) || before.claim?.id === signal.id || before.claim?.episode === before.gate.episode) return false;
  // Resolve the private destination before committing or making the final state observation.
  const address=await resolveAddress(config.host);
  const claim:Claim={id:signal.id,episode:before.gate.episode,sentAt:now(),phase:'claimed',
    signal:[signal.kind,signal.publishedAt,signal.observedAt,signal.dueAt??null]};
  const name=markerPrefix+' '+JSON.stringify(claim);
  const hmac=createHmac('sha256',config.key).update('radar-v1\n'+claim.episode+'\n'+claim.id).digest('hex').slice(0,32);
  const packet=Buffer.concat([Buffer.from('KINOKO1:'+hmac,'ascii'),Buffer.alloc(6,255),...Array<Buffer>(16).fill(config.mac)]);
  // Both writers must repeat the existing tag or GitHub can assign an untagged draft name.
  // The monitor workflow serializes dispatchers; only it writes the claim title.
  const update=await api(path,{method:'PATCH',headers:{'Content-Type':'application/json',
    ...(before.etag && !before.etag.startsWith('W/')?{'If-Match':before.etag}:{})},body:JSON.stringify({name,tag_name:gateTag})});
  if (update.status === 409 || update.status === 412) return false;
  if (!update.ok) throw Error('radar_claim_unavailable');
  const stillAuthorized = (value:ReturnType<typeof releaseGate>) => value.name === name
    && value.gate.episode === before.gate.episode && value.gate.at === before.gate.at && armed(value.gate,signal,due,now());
  if (!stillAuthorized(releaseGate(await update.json(),config.releaseId)) || !stillAuthorized(await readGate())) return false;
  await send(packet,config.port,address);
  return true;
}
