export interface TriggerResult {
  hit: boolean;
  payload: string;
}

/** 口令模式：消息以任一触发词开头才进 LLM；触发词为空列表时全接管 */
export function matchTrigger(text: string, triggerWords: string[]): TriggerResult {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { hit: false, payload: "" };
  if (triggerWords.length === 0) return { hit: true, payload: text.trim() };
  for (const word of triggerWords) {
    const w = word.trim().toLowerCase();
    if (w && normalized.startsWith(w)) {
      const payload = text.trim().slice(w.length).trim();
      return payload ? { hit: true, payload } : { hit: false, payload: "" };
    }
  }
  return { hit: false, payload: "" };
}
