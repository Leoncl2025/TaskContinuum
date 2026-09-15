// Ported from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import crypto from "node:crypto";

/**
 * 文件内容指纹,用于乐观锁。
 *
 * 服务端与索引器必须用**同一个**实现,否则 UI 拿到的 hash 永远对不上,
 * 冲突检测会退化成"每次保存都报冲突"。
 */
export function hashOf(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}
