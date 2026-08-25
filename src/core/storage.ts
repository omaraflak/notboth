import { SCHEMA_VERSION, type Project, type ProjectFile } from './types';

const DB_NAME = 'nand';
const DB_VERSION = 1;
const STORE = 'projects';
const META = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  await tx(STORE, 'readwrite', (s) => s.put(structuredClone(p)) as IDBRequest<IDBValidKey>);
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const p = await tx<Project | undefined>(STORE, 'readonly', (s) => s.get(id));
  return p && migrate(p);
}

/**
 * Bring a stored project up to date.
 *
 * Toggles used to be a primitive of their own: a switch you could click, which
 * drove a net and was not a pin. An input port is the same thing with an
 * interface attached -- it has no driver inside the circuit either -- so the
 * two merged, and a stored Toggle becomes the port it was standing in for.
 *
 * The one thing this changes is the component's signature: a Toggle was
 * invisible from outside and a port is not, so a component that had one gains
 * a pin. That pin is unconnected wherever the component is used, which reads
 * as 0 -- the same as a Toggle left off, and different from one left on.
 */
function migrate(p: Project): Project {
  for (const def of p.defs) {
    for (const inst of def.instances) {
      if (inst.def !== 'prim:TOGGLE') continue;
      inst.def = 'prim:IN';
      inst.props.name = inst.props.name || 'sw';
    }
  }
  return p;
}

export async function listProjects(): Promise<Project[]> {
  const all = await tx<Project[]>(STORE, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await tx(STORE, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function setLastOpen(id: string): Promise<void> {
  await tx(META, 'readwrite', (s) => s.put(id, 'lastOpen') as IDBRequest<IDBValidKey>);
}

export async function getLastOpen(): Promise<string | undefined> {
  return tx<string | undefined>(META, 'readonly', (s) => s.get('lastOpen'));
}

/* ------------------------------------------------------------------ *
 * Import / export
 * ------------------------------------------------------------------ */

export function exportProject(p: Project): string {
  const file: ProjectFile = { schema: SCHEMA_VERSION, project: p };
  return JSON.stringify(file, null, 2);
}

export function importProject(text: string): Project {
  const parsed = JSON.parse(text) as ProjectFile | Project;
  const project = 'project' in parsed ? parsed.project : parsed;
  if (!project || !Array.isArray(project.defs)) throw new Error('not a NAND project file');
  // Ids are internal and immutable, but a re-imported copy must not collide
  // with the original, so the project itself is re-keyed.
  project.id = `p_${Math.random().toString(36).slice(2, 12)}`;
  project.updatedAt = Date.now();
  for (const d of project.defs) {
    d.instances ??= [];
    d.wires ??= [];
    d.folder ??= null;
  }
  project.folders ??= [];
  return project;
}

export function downloadFile(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

/* ------------------------------------------------------------------ *
 * Eviction
 * ------------------------------------------------------------------ */

/**
 * Ask the browser not to throw the database away.
 *
 * By default IndexedDB is "best-effort" storage: Safari clears it after seven
 * days without a visit, and every browser may clear it under disk pressure.
 * Someone who spends a fortnight building a CPU should not lose it to a
 * holiday. Granting is at the browser's discretion -- Chrome decides from
 * engagement, Firefox asks, Safari ties it to bookmarking -- so this is a
 * request, not a guarantee, and a refusal is not an error worth reporting.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
