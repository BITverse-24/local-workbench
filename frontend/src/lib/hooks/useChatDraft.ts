import { useCallback, useEffect, useRef, useState } from "react";
import { ChatDraftStore, draftKey, emptyDraft, type ChatDraft } from "../chat-drafts";

export function useChatDraft() {
  const store = useRef(new ChatDraftStore());
  const cache = useRef(new Map<string, ChatDraft>());
  const owner = useRef(draftKey(null));
  const current = useRef<ChatDraft>(emptyDraft());
  const generation = useRef(0);
  const revisions = useRef(new Map<string, number>());
  const states = useRef(new Map<string, { status: "saving" | "saved" | "error"; error?: string }>());
  const [draft, render] = useState(current.current);
  const [status, setStatus] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const save = useCallback(async (key: string, value: ChatDraft) => {
    const revision = (revisions.current.get(key) ?? 0) + 1;
    revisions.current.set(key, revision);
    states.current.set(key, { status: "saving" });
    if (owner.current === key) { setStatus("saving"); setError(null); }
    try {
      await store.current.save(key, value);
      if (revisions.current.get(key) === revision) states.current.set(key, { status: "saved" });
      if (owner.current === key && revisions.current.get(key) === revision) setStatus("saved");
    } catch (error) {
      if (revisions.current.get(key) === revision) states.current.set(key, { status: "error", error: error instanceof Error ? error.message : "Draft could not be saved." });
      if (owner.current === key && revisions.current.get(key) === revision) {
        setStatus("error");
        setError(error instanceof Error ? error.message : "Draft could not be saved.");
      }
      throw error;
    }
  }, []);

  const select = useCallback(async (chatId: string | null) => {
    const version = ++generation.current;
    const key = draftKey(chatId);
    setLoadFailed(false);
    owner.current = key;
    const cached = cache.current.get(key);
    current.current = cached ?? emptyDraft(); render(current.current);
    setError(states.current.get(key)?.error ?? null); setStatus(cached ? states.current.get(key)?.status ?? "saved" : "loading");
    if (cached) return;
    try {
      const value = await store.current.load(key);
      if (generation.current !== version) return;
      cache.current.set(key, value); current.current = value; render(value); setStatus("saved");
    } catch (error) {
      if (generation.current !== version) return;
      setLoadFailed(true); setStatus("error"); setError(error instanceof Error ? error.message : "Saved draft could not be read.");
    }
  }, []);

  useEffect(() => { void select(null); }, [select]);

  const update = useCallback((change: Partial<ChatDraft> | ((draft: ChatDraft) => ChatDraft)) => {
    generation.current++;
    const value = typeof change === "function" ? change(current.current) : { ...current.current, ...change };
    current.current = value; cache.current.set(owner.current, value); render(value);
    void save(owner.current, value).catch(() => undefined);
  }, [save]);

  const clear = useCallback(async (chatId: string | null) => {
    const key = draftKey(chatId), value = emptyDraft();
    cache.current.set(key, value);
    if (owner.current === key) { generation.current++; current.current = value; render(value); }
    await save(key, value);
  }, [save]);

  const put = useCallback(async (chatId: string | null, value: ChatDraft) => {
    const key = draftKey(chatId); cache.current.set(key, value);
    if (owner.current === key) { generation.current++; current.current = value; render(value); }
    await save(key, value);
  }, [save]);

  return { draft, status, error, loadFailed, select, update, clear, put,
    retry: () => cache.current.has(owner.current) ? save(owner.current, current.current) : select(owner.current === "new-chat" ? null : owner.current),
    flush: () => save(owner.current, current.current),
  };
}
