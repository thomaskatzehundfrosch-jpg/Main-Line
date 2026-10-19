/** Cloud repertoire storage. Payload chunks avoid Firestore's document and nesting limits. */
import { Bytes, collection, doc, getDocs, getDoc, writeBatch, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { RepertoireFile } from '../types/repertoireFile';
import type { Card } from './srScheduler';
import type { SRLifetimeStats } from './srStorage';

const CHUNK_BYTES = 400_000;
// Keep atomic commits below Firestore's 10 MiB request limit, including overhead.
const MAX_BYTES = 8_000_000;
const queues = new Map<string, Promise<void>>();
function serialized(key: string, operation: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
function root(userId: string, kind: string, id: string) {
  if (!db) throw new Error('Firebase is not configured.');
  return doc(db, 'users', userId, kind, encodeURIComponent(id));
}

async function savePayload(userId: string, kind: string, id: string, value: unknown) {
  const ref = root(userId, kind, id);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new Error('This cloud item exceeds the 8 MB sync limit. Export a local backup.');
  const oldChunks = await getDocs(collection(ref, 'chunks'));
  const batch = writeBatch(db!);
  const count = Math.ceil(bytes.length / CHUNK_BYTES);
  oldChunks.docs.filter(chunk => Number(chunk.id) >= count).forEach(chunk => batch.delete(chunk.ref));
  for (let i = 0; i < count; i++) {
    batch.set(doc(ref, 'chunks', String(i)), {
      payload: Bytes.fromUint8Array(bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
    });
  }
  batch.set(ref, { chunkCount: count, format: 1 });
  await batch.commit();
}

async function readPayload(userId: string, kind: string, id: string): Promise<unknown | null> {
  const ref = root(userId, kind, id);
  // One query observes the chunks from an atomic replacement together.
  const chunks = await getDocs(collection(ref, 'chunks'));
  if (chunks.empty) return null;
  const ordered = chunks.docs.sort((a, b) => Number(a.id) - Number(b.id));
  const arrays = ordered.map(chunk => (chunk.data().payload as Bytes).toUint8Array());
  const bytes = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  arrays.forEach(array => { bytes.set(array, offset); offset += array.length; });
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function fetchRemoteFiles(userId: string): Promise<RepertoireFile[]> {
  if (!db) return [];
  const snapshot = await getDocs(collection(db, 'users', userId, 'repertoires'));
  const files = await Promise.all(snapshot.docs.map(item => readPayload(userId, 'repertoires', decodeURIComponent(item.id))));
  return (files.filter(Boolean) as RepertoireFile[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function upsertRemoteFile(userId: string, file: RepertoireFile): Promise<void> {
  if (!db) return Promise.resolve();
  // Snapshot immediately so a queued save cannot change underneath serialization.
  const snapshot = JSON.parse(JSON.stringify(file)) as RepertoireFile;
  return serialized(`${userId}:file:${file.id}`, () => savePayload(userId, 'repertoires', file.id, snapshot));
}
export function deleteRemoteFile(userId: string, fileId: string): Promise<void> {
  if (!db) return Promise.resolve();
  return serialized(`${userId}:file:${fileId}`, async () => {
    const ref = root(userId, 'repertoires', fileId);
    const chunks = await getDocs(collection(ref, 'chunks'));
    const batch = writeBatch(db!);
    chunks.docs.forEach(chunk => batch.delete(chunk.ref));
    batch.delete(ref);
    await batch.commit();
  });
}
export async function pushAllFilesToCloud(userId: string, files: RepertoireFile[]) {
  for (const file of files) await upsertRemoteFile(userId, file);
}
export async function fetchRemoteCards(userId: string): Promise<Card[]> {
  if (!db) return [];
  return (await readPayload(userId, 'training', 'cards') as Card[] | null) ?? [];
}
export function saveAllRemoteCards(userId: string, cards: Card[]): Promise<void> {
  if (!db) return Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(cards)) as Card[];
  return serialized(`${userId}:cards`, () => savePayload(userId, 'training', 'cards', snapshot));
}
export function upsertRemoteCard(userId: string, card: Card): Promise<void> {
  if (!db) return Promise.resolve();
  return serialized(`${userId}:cards`, async () => {
    const cards = await fetchRemoteCards(userId);
    await savePayload(userId, 'training', 'cards', [...cards.filter(c => c.id !== card.id), card]);
  });
}
export async function fetchRemoteStats(userId: string): Promise<SRLifetimeStats | null> {
  if (!db) return null;
  const snapshot = await getDoc(root(userId, 'training', 'stats'));
  return snapshot.exists() ? snapshot.data() as SRLifetimeStats : null;
}
export async function upsertRemoteStats(userId: string, stats: SRLifetimeStats) {
  if (db) await setDoc(root(userId, 'training', 'stats'), { ...stats });
}
