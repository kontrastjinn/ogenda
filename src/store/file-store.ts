export interface FileStore {
  /** returns file content, or null if the file does not exist */
  read(path: string): Promise<string | null>;
  /** create the file if missing, otherwise overwrite */
  write(path: string, content: string): Promise<void>;
  /** create the folder (idempotent) */
  ensureFolder(path: string): Promise<void>;
  
  /** paths of folders directly inside a folder (non-recursive); [] if none */  
listFolders(folder: string): Promise<string[]>;
  list(folder: string): Promise<string[]>;
  listFolders(folder: string): Promise<string[]>
}

export class InMemoryFileStore implements FileStore {
  files = new Map<string, string>();
  folders = new Set<string>();
  async read(path: string): Promise<string | null> {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
  async listFolders(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    const subs = new Set<string>();
    for (const p of [...this.files.keys(), ...this.folders]) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const idx = rest.indexOf("/");
      if (idx > 0) subs.add(prefix + rest.slice(0, idx));
    }
    return [...subs];
  }
}
