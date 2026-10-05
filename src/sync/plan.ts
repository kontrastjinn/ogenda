import { AgendaEvent, hashEvent, parseReminderMinutes, unescapeMultiline } from "../core/event";
import { LocalEvent } from "../store/monthly-store";

export interface SyncConflict {
  uid: string;
  local: LocalEvent;
  server: AgendaEvent;
  /** Set when `server` carries a category restored from the local block (see `withLocalCategory`). */
  restoreBaseHash?: string;
}

export interface SyncPlan {
  pushUpdate: AgendaEvent[];
  pushCreate: AgendaEvent[];
  applyServer: AgendaEvent[];
  /**
   * Local no-href blocks whose uid already exists on the server: record the server's
   * href/etag locally instead of blindly re-creating (a re-PUT would clobber the server
   * copy every round without ever making progress).
   */
  adopt: AgendaEvent[];
  conflicts: SyncConflict[];
  /**
   * Server-changed events whose new server copy lost the category the local block still has.
   * Applied locally with the category kept, then PUT back so the server gets CATEGORIES again.
   * baseHash is the hash of the category-less server copy, so a failed PUT retries next round.
   */
  restoreCategory: AgendaEvent[];
  deleteRemote: { uid: string; href: string; etag: string }[];
  markServerDeleted: AgendaEvent[];
}

/** Reconstructs the calendar-writable fields (+ sync metadata) of an AgendaEvent from a monthly-doc block. */
export function fieldsToEvent(fields: Record<string, string>): AgendaEvent {
  const attendees = (fields["attendees"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exdates = (fields["exdates"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reminderRaw = Object.prototype.hasOwnProperty.call(fields, "reminders") ? fields["reminders"] : fields["reminder"];
  const reminders = parseReminderMinutes(reminderRaw);
  return {
    uid: fields["uid"] ?? "",
    title: fields["title"] ?? "",
    start: fields["start"] ?? "",
    end: fields["end"],
    allDay: fields["all_day"] === undefined ? undefined : fields["all_day"] === "true",
    tz: fields["tz"],
    location: fields["location"],
    description: fields["description"] ? unescapeMultiline(fields["description"]) : undefined,
    organizer: fields["organizer"],
    attendees: attendees.length ? attendees : undefined,
    status: fields["status"],
    category: fields["category"],
    rrule: fields["rrule"],
    exdates: exdates.length ? exdates : undefined,
    ...(reminders ? { reminders } : {}),
    reminder: reminders?.[0],
    origin: fields["origin"] === "synced" ? "synced" : "local",
    href: fields["href"],
    etag: fields["etag"],
    baseHash: fields["base_hash"],
  };
}

/**
 * Calendar apps without a category concept (Apple Calendar) drop CATEGORIES when they save
 * an edited event. A category the server copy lost is treated as still set: the server copy
 * gets the local category back, and its baseHash is the category-less server hash.
 */
function withLocalCategory(s: AgendaEvent, l: LocalEvent): AgendaEvent | undefined {
  const category = l.fields["category"];
  if (s.category || !category) return undefined;
  return { ...s, category, baseHash: hashEvent(s) };
}

/**
 * Three-way diff (spec §6): local hash vs base_hash detects local edits;
 * server etag vs the locally-recorded etag detects server-side changes.
 * Deletion propagation (local block removed, or server no longer has a
 * previously-synced uid) is out of scope for D2 — see D3.
 */
export function planSync(
  server: AgendaEvent[],
  local: LocalEvent[],
  tracked: Record<string, { href: string; etag: string }> = {}
): SyncPlan {
  const serverByUid = new Map(server.map((s) => [s.uid, s]));
  const localUids = new Set(local.map((l) => l.uid));
  const localByUid = new Map(local.map((l) => [l.uid, l]));

  const pushUpdate: AgendaEvent[] = [];
  const pushCreate: AgendaEvent[] = [];
  const applyServer: AgendaEvent[] = [];
  const adopt: AgendaEvent[] = [];
  const conflicts: SyncConflict[] = [];
  const restoreCategory: AgendaEvent[] = [];
  const deleteRemote: { uid: string; href: string; etag: string }[] = [];
  const markServerDeleted: AgendaEvent[] = [];

  for (const l of local) {
    if (!l.hasHref) {
      const s = serverByUid.get(l.uid);
      if (s?.href) {
        // Adoption: the block predates href tracking (e.g. an import), yet the server
        // already holds this uid. Take the server's href/etag into the local block;
        // base_hash is the SERVER event's hash, so any real content difference shows up
        // as a pushUpdate next round and the local version wins the push.
        adopt.push({
          ...fieldsToEvent(l.fields),
          origin: "synced",
          href: s.href,
          etag: s.etag,
          baseHash: hashEvent(s),
        });
      } else {
        pushCreate.push(fieldsToEvent(l.fields));
      }
      continue;
    }
    const s = serverByUid.get(l.uid);
    if (!s) continue; // previously synced, but this fetch has no matching uid — not a D2 concern

    const localChanged = hashEvent(fieldsToEvent(l.fields)) !== (l.fields["base_hash"] ?? "");  
    const serverChanged = s.etag !== l.fields["etag"];  
    // Ingest-format migration: etag unchanged but the stored representation drifted  
    // (e.g. events ingested before UTC→local wall-clock conversion). Re-apply the  
    // server version locally; no server write needed since the instant is identical.  
    const formatDrift =  
      s.start !== (l.fields["start"] ?? "") ||  
      (s.end ?? "") !== (l.fields["end"] ?? "") ||  
      (s.tz ?? "") !== (l.fields["tz"] ?? "");  
  
    const restored = withLocalCategory(s, l);
    if (localChanged && serverChanged) {
      conflicts.push(
        restored
          ? { uid: l.uid, local: l, server: restored, restoreBaseHash: restored.baseHash }
          : { uid: l.uid, local: l, server: s },
      );
    } else if (localChanged) {
      pushUpdate.push(fieldsToEvent(l.fields));
    } else if (serverChanged || formatDrift) {
      if (restored) restoreCategory.push(restored);
      else applyServer.push(s);
    }
  }

  for (const s of server) {
    if (!localUids.has(s.uid)) applyServer.push(s);
  }

  // D3: reconcile against the last-known-synced ledger to tell "brand-new server event"
  // apart from "event whose local block (or server copy) the user deleted since last sync".
  // Separate loop, per spec — does not replace or modify the two loops above.
  for (const trackedUid of Object.keys(tracked)) {
    const l = localByUid.get(trackedUid);
    const s = serverByUid.get(trackedUid);
    if (!l && s) {
      // local deletion: use the server's current href/etag, not the possibly-stale tracked value
      deleteRemote.push({ uid: trackedUid, href: s.href ?? "", etag: s.etag ?? "" });
    } else if (l && !s) {
      // server deletion: reconstruct the AgendaEvent from the local block so it can be flagged
      markServerDeleted.push({ ...fieldsToEvent(l.fields), serverDeleted: true });
    }
    // else: both sides already gone (no action), or both present (handled by the branches above)
  }

  // A local deletion must not be undone by loop 2 re-applying the still-present server copy.
  const deletedRemoteUids = new Set(deleteRemote.map((d) => d.uid));
  const reconciledApplyServer = applyServer.filter((s) => !deletedRemoteUids.has(s.uid));

  return {
    pushUpdate,
    pushCreate,
    applyServer: reconciledApplyServer,
    adopt,
    conflicts,
    restoreCategory,
    deleteRemote,
    markServerDeleted,
  };
}
