/**
 * botRef.ts — singleton container pour la reference a l'instance Bot grammY.
 *
 * Evite les imports circulaires quand un module comme `handlers/approval.ts`
 * doit envoyer un message sans passer par un Context (cas : requestApproval()
 * appele depuis le callback canUseTool du SDK, hors de tout handler).
 *
 * Pattern :
 *   - `index.ts` appelle `setBotRef(bot)` au demarrage.
 *   - Les modules consommateurs appellent `getBotRef()` pour envoyer
 *     directement via `bot.api.sendMessage(...)`.
 */

import type { Bot } from "grammy";

let botRef: Bot | null = null;

export function setBotRef(bot: Bot): void {
  botRef = bot;
}

export function getBotRef(): Bot {
  if (!botRef) {
    throw new Error("botRef not initialized. Call setBotRef(bot) at startup.");
  }
  return botRef;
}
