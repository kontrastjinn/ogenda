import { AgendaEvent } from "../core/event";
import { parseMonthlyDoc, serializeMonthlyDoc, upsertEvents } from "../core/monthly-doc";
import { FileStore } from "./file-store";
import { SyncState, readSyncState as readSyncStateFile, writeSyncState as writeSyncStateFile } from "./sync-state";

export function monthOf(startIso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(startIso);
  return m ? `${m[1]}-${m[2]}` : "unknown";
}

/** Optional fields the panel edit form owns — blanking one should delete it. Metadata is never here. */
const PANEL_CLEARABLE_FIELDS = [
  "end", "location", "organizer", "attendees", "status", "rsvp", "category", "description", "reminder", "reminders",
];

/** 月度文件名契约:只有 YYYY-MM.md 是月度日程笔记。同目录的备份(.bak)、杂散笔记、
 *  同步状态文件等一律不参与解析/删改——否则旧快照里的事件会被当成新日程重复显示。 */
/**
 * Monthly agenda file layout update for kontrastjinn/ogenda
 * New write layout:  <storageFolder>/YYYY/⸔YYYY-MM.md
 *   - Files written to per-year subfolders with U+2E14 (⸔) prefix
 * Legacy read layout: <storageFolder>/YYYY-MM.md
 *   - Flat folder structure (no subfolders), no prefix.
 * ∵ Both schemes must be readable. No data migration needed.
 * MONTHLY_FILE_RE regex pattern: /^(⸔)?\d{4}-\d{2}\.md$/
 *   - Accepts optional ⸔ prefix to support both new and legacy file names
 *   - Ensures compatibility with existing YYYY-MM.md files
 */
const MONTHLY_FILE_RE = /^(⸔)?\d{4}-\d{2}\.md$/;

/** 从目录 listing 中筛出月度笔记文件(按文件名,与 pathFor 的写入侧对应)。 */
function monthlyPaths(paths: string[]): string[] {
  return paths.filter((p) => MONTHLY_FILE_RE.test(p.slice(p.lastIndexOf("/") + 1)));
}

/**
 * Server-authoritative optional fields: when a synced server event no longer carries one,
 * the local md field is deleted on apply (otherwise the stale value's hash would differ from
 * the server-based base_hash and ogenda would "push the ghost back", fighting other devices).
 * Local-only fields (rsvp) and ALL sync metadata (etag/href/base_hash/...) are never here.
 */
const SYNC_CLEARABLE_FIELDS = [
  "end", "location", "organizer", "attendees", "status", "category", "description", "rrule", "exdates", "reminder", "reminders",
];

export interface SyncSummary {
  added: number;
  updated: number;
  months: string[];
}

export interface ReadEventsResult {
  events: LocalEvent[];
  /** Blocks that carry no uid or no usable start date, and so cannot be shown. */
  skipped: number;
}

/** A parsed local event block, as found in a monthly file (not yet reconciled with the server). */
export interface LocalEvent {
  uid: string;
  fields: Record<string, string>;
  prose: string;
  /** true if the block carries an href:: (was previously synced via CalDAV) */
  hasHref: boolean;
}

export class MonthlyStore {
  constructor(private store: FileStore, private folder: string) {}

  private pathFor(month: string): string {
    return `${this.folder}/${month.slice(0,4)}/⸔${month}.md`;
  }

  async sync(events: AgendaEvent[]): Promise<SyncSummary> {
    const byMonth = new Map<string, AgendaEvent[]>();
    for (const ev of events) {
      const month = monthOf(ev.start);
      const list = byMonth.get(month) ?? [];
      list.push(ev);
      byMonth.set(month, list);
    }
    let added = 0;
    let updated = 0;
    const months: string[] = [];
    /** 
    Originally, sync() calls ensureFolder(this.folder) once and
    * savePanelEvent does the same. After the change, pathFor(month)
    * writes to ${folder}/2026/⸔2026-09.md — the 2026/ subfolder may not exist
    * yet, and write() does not create directories. So each call site must ensure the
    * year subfolder, which varies per month in sync()'s loop: */
    const years = new Set([...byMonth.keys()].map((m) => m.slice(0, 4)));  
    for (const y of years) {  
      await this.store.ensureFolder(`${this.folder}/${y}`);  
    }  
    for (const [month, monthEvents] of byMonth) {
      const path = this.pathFor(month);
      const existing = (await this.store.read(path)) ?? "";
      const seed = existing || `# ${month}\n`;
      const r = upsertEvents(seed, monthEvents, { clearFields: SYNC_CLEARABLE_FIELDS });
      // skip the write entirely when nothing changed (avoids churn + misleading "updated" counts)
      if (r.added > 0 || r.updated > 0) {
        await this.store.write(path, r.text);
        added += r.added;
        updated += r.updated;
        months.push(month);
      }
    }
    return { added, updated, months };
  }

  async readEvents(): Promise<ReadEventsResult> {
    const paths = await this.allMonthlyPaths();
    const out: LocalEvent[] = [];
    let skipped = 0;
    for (const path of paths) {
      const text = await this.store.read(path);
      if (!text) continue;
      const { blocks } = parseMonthlyDoc(text);
      for (const b of blocks) {
        const uid = b.fields["uid"];
        // A block without a uid or a readable start renders nowhere; count it so
        // the panel can say so instead of quietly showing less than the file holds.
        if (!uid || !/^\d{4}-\d{2}-\d{2}/.test(b.fields["start"] ?? "")) {
          skipped++;
          continue;
        }
        out.push({ uid, fields: b.fields, prose: b.prose, hasHref: Boolean(b.fields["href"]) });
      }
    }
    return { events: out, skipped };
  }

  async readSyncState(): Promise<SyncState> {
    return readSyncStateFile(this.store, this.folder);
  }

  async writeSyncState(state: SyncState): Promise<void> {
    return writeSyncStateFile(this.store, this.folder, state);
  }

  /**
    * Panel-edit write path: like sync() for a single event, but blanked optional
    * fields are DELETED (clearFields). Sync's merge semantics (which protect
    * href/etag/base_hash) are intentionally left untouched — see upsertEvents.
    */
  async savePanelEvent(event: AgendaEvent): Promise<SyncSummary> {
    // sync() — inside the loop, per month (or pre-collect unique years)
    const month = monthOf(event.start);
    await this.store.ensureFolder(`${this.folder}/${month.slice(0,4)}`);
    const path = this.pathFor(month);
    const existing = (await this.store.read(path)) ?? "";
    const seed = existing || `# ${month}\n`;
    const r = upsertEvents(seed, [event], { clearFields: PANEL_CLEARABLE_FIELDS });
    if (r.added > 0 || r.updated > 0) {
      await this.store.write(path, r.text);
    }
    return { added: r.added, updated: r.updated, months: r.added > 0 || r.updated > 0 ? [month] : [] };
  }

  
  private async allMonthlyPaths(): Promise<string[]> {
    const rootFiles = await this.store.list(this.folder);
    const subfolders = (await this.store.listFolders(this.folder))
      .filter((f) => /^\d{4}$/.test(f.slice(f.lastIndexOf("/") + 1)));
    const nested = (await Promise.all(subfolders.map((f) => this.store.list(f)))).flat();
    return monthlyPaths([...rootFiles, ...nested]);
  }
  
  /** Removes event blocks matching the given uids from whichever monthly files contain them. */
  async removeByUid(uids: string[]): Promise<void> {
    if (uids.length === 0) return;
    const uidSet = new Set(uids);
    const paths = await this.allMonthlyPaths();
    for (const path of paths) {
      const text = await this.store.read(path);
      if (!text) continue;
      const { preamble, blocks } = parseMonthlyDoc(text);
      const remaining = blocks.filter((b) => !uidSet.has(b.fields["uid"]));
      // skip the write entirely when no block in this file matched (avoids churn)
      if (remaining.length === blocks.length) continue;
      await this.store.write(path, serializeMonthlyDoc(preamble, remaining));
    }
  }
}
