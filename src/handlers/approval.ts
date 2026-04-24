/**
 * approval.ts — handler de demande d'approbation via Telegram.
 *
 * Reutilise le pattern QW3 (MCP ask_user) mais en simplifie pour la demande
 * d'approbation de commandes dangereuses : 4 choix fixes au lieu de N options libres.
 *
 * Flux :
 *   1. canUseTool (permissions.ts) appelle requestApproval()
 *   2. Ecrit /tmp/approval-{uuid}.json avec {tool, command, reason, chat_id, status: "pending"}
 *   3. Le bot (depuis checkPendingApprovalRequests appele sur chaque event) envoie
 *      un message avec 4 boutons inline : Une fois / Session / Toujours / Refuser
 *   4. User clique -> callback_query `approval:{uuid}:{choice}`
 *   5. Handler ecrit /tmp/approval-{uuid}.response.json
 *   6. requestApproval polle le fichier, retourne ApprovalChoice
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { ApprovalChoice } from "../permissions";
import { getBotRef } from "../botRef";
import { readdirSync } from "fs";
void readdirSync; // in case Bun.Glob API surface changes later

const TMP_DIR = process.env.ECOSYS_APPROVAL_TMP_DIR || "/tmp";
const APPROVAL_TIMEOUT_MS = parseInt(
  process.env.ECOSYS_APPROVAL_TIMEOUT_MS || "60000",
  10,
);
const POLL_INTERVAL_MS = 500;

type ApprovalPending = {
  request_id: string;
  chat_id: number;
  tool: string;
  command: string;
  reason: string;
  status: "pending" | "sent" | "answered";
  created_at: number;
  /**
   * S11 Pattern 2: short 5-char code (lowercase a-k, m-z) for text-based
   * permission reply on mobile when inline buttons aren't convenient.
   * Ported from claude-plugins-official/telegram PERMISSION_REPLY_RE.
   * Alphabet excludes "l" (confuses with "1" / "I").
   */
  short_code: string;
};

const SHORT_CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no 'l'

function generateShortCode(length = 5): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out +=
      SHORT_CODE_ALPHABET[
        Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)
      ];
  }
  return out;
}

/**
 * Regex matching text-based permission replies like "y abcde" / "yes abcde" /
 * "n abcde" / "no abcde". Case-insensitive for phone autocorrect. Strict:
 * no bare yes/no (too conversational), no prefix/suffix chatter.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

type ApprovalResponse = {
  request_id: string;
  choice: ApprovalChoice;
};

export function buildApprovalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Une fois", `approval:${requestId}:once`)
    .text("Session", `approval:${requestId}:session`)
    .row()
    .text("Toujours", `approval:${requestId}:always`)
    .text("Refuser", `approval:${requestId}:deny`);
}

function requestPath(requestId: string): string {
  return `${TMP_DIR}/approval-${requestId}.json`;
}

function responsePath(requestId: string): string {
  return `${TMP_DIR}/approval-${requestId}.response.json`;
}

/**
 * Appele par canUseTool. Genere un request, ecrit le fichier, polle la reponse.
 */
export async function requestApproval(
  sessionKey: string,
  toolName: string,
  command: string,
  reason: string,
): Promise<ApprovalChoice> {
  // sessionKey = "{chat_id}:{thread_id || 0}"
  const chatIdStr = sessionKey.split(":")[0] ?? "";
  const chatId = parseInt(chatIdStr, 10);
  if (!chatId || isNaN(chatId)) {
    console.warn("[approval] invalid sessionKey, denying:", sessionKey);
    return "deny";
  }

  const requestId = randomUUID();
  const shortCode = generateShortCode(5);
  const payload: ApprovalPending = {
    request_id: requestId,
    chat_id: chatId,
    tool: toolName,
    command,
    reason,
    status: "pending",
    created_at: Date.now(),
    short_code: shortCode,
  };

  try {
    writeFileSync(requestPath(requestId), JSON.stringify(payload));
  } catch (error) {
    console.error("[approval] failed to write request file:", error);
    return "deny";
  }

  // Envoie immediatement les boutons inline au chat via le bot singleton.
  // Si getBotRef() n'est pas init (cas test hors bot), on retombe sur timeout apres 60s.
  try {
    const bot = getBotRef();
    const preview =
      command.length > 2500 ? command.slice(0, 2500) + "..." : command;
    const msg =
      `Approbation requise - ${reason}\n\n` +
      "```\n" +
      preview +
      "\n```\n\n" +
      `Choisis (ou reponds \`y ${shortCode}\` / \`n ${shortCode}\`) :`;
    await bot.api.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: buildApprovalKeyboard(requestId),
    });

    // Marque le request comme envoye
    payload.status = "sent";
    writeFileSync(requestPath(requestId), JSON.stringify(payload));
  } catch (error) {
    console.error("[approval] failed to send approval message:", error);
    // On continue a poller quand meme : /approve /deny texte fonctionne toujours
  }

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      if (existsSync(responsePath(requestId))) {
        try {
          const raw = readFileSync(responsePath(requestId), "utf-8");
          const resp = JSON.parse(raw) as ApprovalResponse;
          if (
            resp.choice &&
            ["once", "session", "always", "deny"].includes(resp.choice)
          ) {
            return resp.choice;
          }
        } catch (error) {
          console.warn("[approval] invalid response file:", error);
        }
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    return "timeout";
  } finally {
    // cleanup best-effort
    for (const p of [requestPath(requestId), responsePath(requestId)]) {
      try {
        unlinkSync(p);
      } catch {
        // missing is fine
      }
    }
  }
}

/**
 * Appele par chaque handler de message pour detecter des approvals pending
 * et envoyer les boutons. Inspire de `checkPendingAskUserRequests()` dans streaming.ts.
 */
export async function checkPendingApprovalRequests(
  ctx: Context,
  chatId: number,
): Promise<void> {
  const glob = new Bun.Glob("approval-*.json");
  for await (const filename of glob.scan({ cwd: TMP_DIR, absolute: false })) {
    // skip les .response.json
    if (filename.includes(".response.")) continue;

    const filepath = `${TMP_DIR}/${filename}`;
    try {
      const raw = await Bun.file(filepath).text();
      const data = JSON.parse(raw) as ApprovalPending;

      if (data.status !== "pending") continue;
      if (data.chat_id !== chatId) continue;

      const escaped =
        `${data.tool === "Bash" ? "Commande" : "Tool"} : ${data.command}`.slice(
          0,
          3000,
        );
      const msg =
        `Approbation requise — ${data.reason}\n\n` +
        "```\n" +
        escaped +
        "\n```\n\n" +
        "Choisis :";
      const keyboard = buildApprovalKeyboard(data.request_id);
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });

      data.status = "sent";
      await Bun.write(filepath, JSON.stringify(data));
    } catch (error) {
      console.warn(`[approval] failed to process ${filepath}:`, error);
    }
  }
}

/**
 * Ecrit le fichier de reponse pour un requestId. Appele par callback.ts
 * quand l'utilisateur clique sur un bouton `approval:{uuid}:{choice}`.
 */
export function writeApprovalResponse(
  requestId: string,
  choice: ApprovalChoice,
): void {
  const payload: ApprovalResponse = { request_id: requestId, choice };
  try {
    writeFileSync(responsePath(requestId), JSON.stringify(payload));
  } catch (error) {
    console.error("[approval] failed to write response file:", error);
  }
}

/**
 * S11 Pattern 2: resolve an approval by its short 5-char code (text reply).
 * Called by the text middleware in index.ts when it detects `y abcde` or `n abcde`.
 * Returns true if a matching pending approval was found and resolved, false otherwise.
 */
export function resolveApprovalByShortCode(
  chatId: number,
  shortCode: string,
  choice: ApprovalChoice,
): boolean {
  const code = shortCode.toLowerCase();
  const glob = new Bun.Glob("approval-*.json");
  for (const filename of glob.scanSync({ cwd: TMP_DIR, absolute: false })) {
    if (filename.includes(".response.")) continue;
    const filepath = `${TMP_DIR}/${filename}`;
    try {
      const raw = readFileSync(filepath, "utf-8");
      const data = JSON.parse(raw) as ApprovalPending;
      if (data.chat_id !== chatId) continue;
      if (data.short_code !== code) continue;
      writeApprovalResponse(data.request_id, choice);
      return true;
    } catch {
      // unreadable file, skip
    }
  }
  return false;
}
