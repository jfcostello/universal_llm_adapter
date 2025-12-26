import type { VectorPoint } from '../../../../kernel/index.js';

export type MemoryCollections = Map<string, Map<string, VectorPoint>>;

export function ensureCollection(collections: MemoryCollections, collection: string): Map<string, VectorPoint> {
  let coll = collections.get(collection);
  if (!coll) {
    coll = new Map();
    collections.set(collection, coll);
  }
  return coll;
}

export function getCollection(collections: MemoryCollections, collection: string): Map<string, VectorPoint> | undefined {
  return collections.get(collection);
}

export function upsertPoints(collections: MemoryCollections, collection: string, points: VectorPoint[]): void {
  const coll = ensureCollection(collections, collection);
  for (const point of points) {
    coll.set(point.id, { ...point });
  }
}

export function deletePointsByIds(collections: MemoryCollections, collection: string, ids: string[]): void {
  const coll = collections.get(collection);
  if (!coll) return;
  for (const id of ids) {
    coll.delete(id);
  }
}

export function createCollection(collections: MemoryCollections, collection: string): void {
  ensureCollection(collections, collection);
}

export function deleteCollection(collections: MemoryCollections, collection: string): void {
  collections.delete(collection);
}

export function listCollections(collections: MemoryCollections): string[] {
  return Array.from(collections.keys());
}

export function collectionExists(collections: MemoryCollections, collection: string): boolean {
  return collections.has(collection);
}

export function getCollectionPoints(collections: MemoryCollections, collection: string): VectorPoint[] {
  const coll = collections.get(collection);
  if (!coll) return [];
  return Array.from(coll.values());
}

export function clearCollections(collections: MemoryCollections): void {
  collections.clear();
}

