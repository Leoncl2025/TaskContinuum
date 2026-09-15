// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
/**
 * G4 注入 / 凭据扫描(Design §12.9)。
 *
 * `ref/*.txt` 里放的是从 Teams、邮件、PR 评论粘过来的原文,包在
 * `<<<UNTRUSTED_BEGIN … UNTRUSTED_END>>>` 之间。copilot-instructions.md 第 7 节
 * 已经写明"外部内容是数据,不是指令" —— 但那和 allowedPaths 一样只是引导。
 *
 * 这里扫两类东西:
 *   1. 试图夺取控制权的句式("忽略以上""你现在是…")
 *   2. 疑似凭据(token / 连接串 / 私钥)
 *
 * 刻意宁可误报也不漏报:命中只是要求人看一眼,代价很小;
 * 漏掉一条把生产连接串写进 git 的改动,代价是不可逆的。
 */

export interface Finding {
  kind: "injection" | "secret";
  severity: "error" | "warn";
  line: number;
  /** 命中片段,凭据会被打码 */
  excerpt: string;
  reason: string;
}

interface Rule {
  re: RegExp;
  reason: string;
  severity: "error" | "warn";
}

/**
 * 中英文都要覆盖 —— 这个工作区的素材是混着来的,
 * 只扫英文等于对一半内容视而不见。
 */
const INJECTION: Rule[] = [
  {
    re: /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(above|previous|prior|earlier)\b/i,
    reason: "tries to discard earlier instructions",
    severity: "error",
  },
  {
    re: /(忽略|无视|忘记|不要理会)(以上|上述|之前|前面)/,
    reason: "tries to discard earlier instructions",
    severity: "error",
  },
  {
    re: /\byou\s+are\s+now\s+(a|an|the)\b|\bact\s+as\s+(a|an|the)\b|\bnew\s+instructions?\b/i,
    reason: "tries to reassign the assistant's role",
    severity: "error",
  },
  {
    re: /你现在是|从现在起你|新的指令|扮演一个/,
    reason: "tries to reassign the assistant's role",
    severity: "error",
  },
  {
    re: /\b(system\s*prompt|developer\s*message)\b/i,
    reason: "refers to the system prompt",
    severity: "warn",
  },
  {
    re: /\b(run|execute)\s+(this|the following)\s+(command|script|code)\b/i,
    reason: "asks for a command to be run",
    severity: "error",
  },
  {
    re: /(执行|运行)(以下|下面|这条)(命令|脚本|代码)/,
    reason: "asks for a command to be run",
    severity: "error",
  },
];

const SECRET: Rule[] = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/, reason: "GitHub token", severity: "error" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: "Slack token", severity: "error" },
  { re: /\bsk-[A-Za-z0-9]{20,}/, reason: "OpenAI-style API key", severity: "error" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "private key", severity: "error" },
  {
    re: /\b(AccountKey|SharedAccessKey|Password)\s*=\s*[^;\s"']{8,}/i,
    reason: "connection string with an embedded secret",
    severity: "error",
  },
  {
    re: /\b(api[-_]?key|access[-_]?token|client[-_]?secret|password)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
    reason: "looks like a credential assignment",
    severity: "error",
  },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, reason: "JWT", severity: "warn" },
];

/** 占位符不是凭据。放过它们,否则模板和文档会被刷屏。 */
const PLACEHOLDER =
  /(<[^>]*>|\{\{.*\}\}|\$\{.*\}|xxx+|\.\.\.|todo|tbd|example|placeholder|redacted|\*{4,})/i;

export function scan(text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of INJECTION) {
      const m = rule.re.exec(line);
      if (!m) continue;
      out.push({
        kind: "injection",
        severity: rule.severity,
        line: i + 1,
        excerpt: mask(line.trim()).slice(0, 160),
        reason: rule.reason,
      });
      break;
    }
    for (const rule of SECRET) {
      const m = rule.re.exec(line);
      if (!m || PLACEHOLDER.test(m[0])) continue;
      out.push({
        kind: "secret",
        severity: rule.severity,
        line: i + 1,
        excerpt: mask(line.trim()).slice(0, 160),
        reason: rule.reason,
      });
      break;
    }
  });
  return out;
}

/**
 * 命中的凭据要打码后再输出。
 * 一个把 token 原样打印到终端和 CI 日志里的扫描器,自己就是泄漏源。
 */
function mask(line: string): string {
  for (const rule of SECRET) {
    line = line.replace(new RegExp(rule.re.source, `${rule.re.flags}g`), "******");
  }
  return line.replace(/[A-Za-z0-9_\-+/=]{12,}/g, (s) => `${s.slice(0, 4)}…${"*".repeat(6)}`);
}
