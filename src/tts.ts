/**
 * tts.ts — synthese vocale de la reponse finale via edge-tts.
 *
 * Spawn le script Python `_tts_say.py` (starter ecosysteme-ia) qui wrap edge-tts.
 * Ecrit l'ogg dans /tmp/tts-{uuid}.ogg puis appelle bot.api.sendVoice() pour
 * envoyer une bulle vocale Telegram (style voice note).
 *
 * Appele depuis session.ts apres la reponse Claude si session.voiceMode === "all".
 * Fire-and-forget : on ne bloque pas le retour de sendMessageStreaming.
 */

import { randomUUID } from "crypto";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { InputFile } from "grammy";
import { getBotRef } from "./botRef";

const TTS_SCRIPT =
  process.env.ECOSYS_TTS_SCRIPT || "/app/vault/.claude/scripts/_tts_say.py";
const TMP_DIR = process.env.ECOSYS_TTS_TMP_DIR || "/tmp";

// Max chars to synthesize. edge-tts handles more but longer audio becomes
// unwieldy in Telegram (voice notes > 30s are a UX drag).
const MAX_TTS_CHARS = 2000;

export async function speakResponse(params: {
  chatId: number;
  threadId?: number;
  text: string;
  voice: string;
  replyToMessageId?: number;
}): Promise<void> {
  const { chatId, threadId, text, voice, replyToMessageId } = params;
  if (!text || !text.trim()) return;

  // Strip code fences and markdown markers; TTS doesn't speak "asterisk asterisk"
  let cleanText = text
    .replace(/```[\s\S]*?```/g, " [bloc de code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleanText) return;

  const truncated = cleanText.length > MAX_TTS_CHARS;
  if (truncated) {
    cleanText = cleanText.slice(0, MAX_TTS_CHARS) + ". Reste du texte tronque.";
  }

  if (!existsSync(TTS_SCRIPT)) {
    console.warn(`[tts] script introuvable : ${TTS_SCRIPT}. Skip.`);
    return;
  }

  const uuid = randomUUID();
  const oggPath = `${TMP_DIR}/tts-${uuid}.ogg`;

  try {
    const proc = Bun.spawn(
      ["python3", TTS_SCRIPT, "--voice", voice, "--text", cleanText],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      console.warn(`[tts] script exit=${exitCode}: ${err.slice(0, 500)}`);
      return;
    }
    const audioBuffer = Buffer.from(
      await new Response(proc.stdout).arrayBuffer(),
    );
    if (audioBuffer.length === 0) {
      console.warn("[tts] empty audio output, skip");
      return;
    }
    writeFileSync(oggPath, audioBuffer);

    const bot = getBotRef();
    await bot.api.sendVoice(chatId, new InputFile(oggPath), {
      reply_parameters: replyToMessageId
        ? { message_id: replyToMessageId }
        : undefined,
      message_thread_id: threadId && threadId > 0 ? threadId : undefined,
    });
  } catch (error) {
    console.error("[tts] speakResponse failed:", error);
  } finally {
    try {
      if (existsSync(oggPath)) unlinkSync(oggPath);
    } catch {
      // cleanup best-effort
    }
  }
}
