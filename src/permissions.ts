/**
 * permissions.ts — classification des tool uses + factory canUseTool.
 *
 * Inspire de hermes-agent `tools/approval.py` (Nous Research, MIT) adapte au
 * SDK Anthropic V1 (`@anthropic-ai/claude-agent-sdk`).
 *
 * Flux :
 *   1. SDK appelle canUseTool(toolName, input)
 *   2. On classifie : safe / dangerous
 *   3. Si safe -> { behavior: "allow" } immediat
 *   4. Si dangerous et pattern deja approuve (session/always) -> allow silencieux
 *   5. Sinon -> requestApproval via Telegram (boutons inline), attend reponse
 *   6. Selon choix -> allow | deny
 *
 * Persistance "always approved" : fichier JSON sur disk (survive redemarrage).
 * Persistance "session approved" : Map en memoire par sessionKey.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// ========================================================================
// DANGEROUS_PATTERNS — regex sur le `command` du tool Bash
// ========================================================================
// Chippe + simplifie depuis hermes/tools/approval.py:187 (15 patterns les plus utiles).
// Chaque entree : { pattern, description } — description remontee a l'utilisateur.

export type DangerousMatch = {
  patternKey: string;
  description: string;
};

const DANGEROUS_PATTERNS: Array<{
  key: string;
  pattern: RegExp;
  description: string;
}> = [
  {
    key: "rm-rf-root",
    pattern:
      /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\s+\/(\s|$)/,
    description: "rm -rf sur la racine /",
  },
  {
    key: "rm-rf-home",
    pattern:
      /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\s+(~|\$HOME|\/home\/|\/root\/|\/Users\/)/,
    description: "rm -rf dans un home directory",
  },
  {
    key: "rm-rf-generic",
    pattern:
      /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\b/,
    description: "rm recursif force (-rf)",
  },
  {
    key: "sudo",
    pattern: /\bsudo\s+/,
    description: "escalade de privileges (sudo)",
  },
  {
    key: "dd-disk",
    pattern: /\bdd\s+.*\bof=\/dev\/(sd|nvme|disk|hd)/,
    description: "dd vers un disque brut",
  },
  {
    key: "mkfs",
    pattern: /\bmkfs(\.\w+)?\s+/,
    description: "formatage de systeme de fichiers",
  },
  {
    key: "git-reset-hard",
    pattern: /\bgit\s+reset\s+(--hard|--keep)\b/,
    description: "git reset --hard (perte de commits locaux)",
  },
  {
    key: "git-push-force",
    pattern: /\bgit\s+push\s+.*(--force\b|-f\b|--mirror\b)/,
    description: "git push force (reecriture historique distant)",
  },
  {
    key: "git-clean-hard",
    pattern: /\bgit\s+clean\s+.*-[a-zA-Z]*[fF][a-zA-Z]*[dD]?/,
    description: "git clean -fd (perte de fichiers non trackes)",
  },
  {
    key: "chmod-777",
    pattern: /\bchmod\s+(777|-R\s+777|a\+rwx)/,
    description: "chmod 777 (permissions tout-le-monde)",
  },
  {
    key: "curl-pipe-shell",
    pattern: /\bcurl\s+[^|]*\|\s*(bash|sh|zsh|ksh)\b/,
    description: "curl | bash (execution distante)",
  },
  {
    key: "wget-pipe-shell",
    pattern: /\bwget\s+[^|]*\|\s*(bash|sh|zsh|ksh)\b/,
    description: "wget | bash (execution distante)",
  },
  {
    key: "fork-bomb",
    pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;?\s*:/,
    description: "fork bomb",
  },
  {
    key: "kill-9-all",
    pattern: /\b(kill|pkill)\s+-9\s+-1\b/,
    description: "kill -9 -1 (tue tous les processus)",
  },
  {
    key: "systemctl-destructive",
    pattern: /\bsystemctl\s+(stop|disable|mask|reboot|poweroff|halt)\b/,
    description: "systemctl stop/disable/mask (arret services)",
  },
];

/**
 * Normalise un texte avant match : strip controls, unicode fullwidth -> ASCII.
 * Chippe depuis hermes/tools/approval.py `_normalize()`.
 */
function normalize(text: string): string {
  // strip null bytes + ANSI escapes + CR, puis fullwidth -> ASCII
  let s = text
    .replace(/\x00/g, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "");
  // mapping fullwidth ascii (U+FF01..U+FF5E) vers ascii (U+21..U+7E)
  s = s.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  return s;
}

/**
 * Verifie si un bash command match un pattern dangereux.
 * Retourne null si safe.
 */
export function detectDangerousBash(command: string): DangerousMatch | null {
  if (!command || typeof command !== "string") return null;
  const normalized = normalize(command);
  for (const entry of DANGEROUS_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return { patternKey: entry.key, description: entry.description };
    }
  }
  return null;
}

/**
 * Classifie un tool use comme safe/dangerous.
 * Tools non-bash : tous safe par defaut (Read, Write, Edit, WebSearch, WebFetch, Glob, Grep, MCP...).
 * Tool Bash : verifie regex dangerous patterns.
 */
export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
): DangerousMatch | null {
  if (toolName !== "Bash") return null;
  const command = typeof input.command === "string" ? input.command : "";
  return detectDangerousBash(command);
}

// ========================================================================
// Etat persistant des approbations
// ========================================================================

const ALWAYS_APPROVED_PATH =
  process.env.ECOSYS_APPROVED_PATH ||
  "/app/vault/.cache/approved-commands.json";

type AlwaysApprovedStore = {
  patterns: string[];
  updatedAt: string;
};

let alwaysApprovedCache: Set<string> | null = null;

function loadAlwaysApproved(): Set<string> {
  if (alwaysApprovedCache) return alwaysApprovedCache;
  try {
    if (existsSync(ALWAYS_APPROVED_PATH)) {
      const raw = readFileSync(ALWAYS_APPROVED_PATH, "utf-8");
      const data = JSON.parse(raw) as AlwaysApprovedStore;
      alwaysApprovedCache = new Set(data.patterns || []);
    } else {
      alwaysApprovedCache = new Set();
    }
  } catch (error) {
    console.warn("[permissions] failed to load approved-commands.json:", error);
    alwaysApprovedCache = new Set();
  }
  return alwaysApprovedCache;
}

function persistAlwaysApproved(): void {
  if (!alwaysApprovedCache) return;
  try {
    const dir = dirname(ALWAYS_APPROVED_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: AlwaysApprovedStore = {
      patterns: Array.from(alwaysApprovedCache),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(ALWAYS_APPROVED_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(
      "[permissions] failed to persist approved-commands.json:",
      error,
    );
  }
}

export function addAlwaysApproved(patternKey: string): void {
  const store = loadAlwaysApproved();
  store.add(patternKey);
  persistAlwaysApproved();
}

export function isAlwaysApproved(patternKey: string): boolean {
  return loadAlwaysApproved().has(patternKey);
}

// Session-scoped approvals (lost on restart — voluntarily)
const sessionApproved = new Map<string, Set<string>>();

export function addSessionApproved(
  sessionKey: string,
  patternKey: string,
): void {
  if (!sessionApproved.has(sessionKey))
    sessionApproved.set(sessionKey, new Set());
  sessionApproved.get(sessionKey)!.add(patternKey);
}

export function isSessionApproved(
  sessionKey: string,
  patternKey: string,
): boolean {
  return sessionApproved.get(sessionKey)?.has(patternKey) ?? false;
}

// ========================================================================
// canUseTool factory
// ========================================================================

export type ApprovalChoice = "once" | "session" | "always" | "deny" | "timeout";

/**
 * Delegate qui demande l'approbation a l'utilisateur (via bot Telegram).
 * Implemente ailleurs (handlers/approval.ts) pour eviter circular import.
 */
export type RequestApprovalFn = (
  sessionKey: string,
  toolName: string,
  command: string,
  reason: string,
) => Promise<ApprovalChoice>;

/**
 * Factory de canUseTool. Appelee par session.ts avec le sessionKey courant
 * + le requestApproval delegate (qui ecrit le fichier et envoie le bouton).
 */
export function createCanUseTool(
  sessionKey: string,
  requestApproval: RequestApprovalFn,
) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    _options: { signal: AbortSignal; toolUseID: string },
  ) {
    const danger = classifyToolUse(toolName, input);
    if (!danger) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // Deja approuve pour cette session ou pour toujours ?
    if (
      isSessionApproved(sessionKey, danger.patternKey) ||
      isAlwaysApproved(danger.patternKey)
    ) {
      return { behavior: "allow" as const, updatedInput: input };
    }

    // Demande a l'utilisateur
    const command =
      typeof input.command === "string" ? input.command : JSON.stringify(input);
    const choice = await requestApproval(
      sessionKey,
      toolName,
      command,
      danger.description,
    );

    switch (choice) {
      case "once":
        return { behavior: "allow" as const, updatedInput: input };
      case "session":
        addSessionApproved(sessionKey, danger.patternKey);
        return { behavior: "allow" as const, updatedInput: input };
      case "always":
        addAlwaysApproved(danger.patternKey);
        return { behavior: "allow" as const, updatedInput: input };
      case "deny":
        return {
          behavior: "deny" as const,
          message: `L'utilisateur a refuse l'execution de cette commande (${danger.description}). Ne reessaie pas cette commande sans son accord explicite.`,
        };
      case "timeout":
        return {
          behavior: "deny" as const,
          message: `Aucune reponse de l'utilisateur sur l'approbation de la commande (${danger.description}). Commande annulee. Tu peux lui demander de reformuler s'il veut l'executer.`,
        };
    }
  };
}
