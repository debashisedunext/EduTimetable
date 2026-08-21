import { BadRequestException, ConflictException } from "@nestjs/common";
import type { SessionTokenPayload } from "@edutimetable/shared";

export interface AuthedRequest {
  user: SessionTokenPayload;
}

/** For DELETEs: a foreign-key restriction means the row is still referenced —
 *  say so plainly instead of the create-flavoured "referenced record" message. */
export async function del<T>(op: () => Promise<T>, what: string): Promise<T> {
  try {
    return await op();
  } catch (e: any) {
    if (e?.code === "P2003")
      throw new ConflictException(
        `${what} is still in use (curriculum rows, mappings, sections, or timetable slots reference it) — remove those first`,
      );
    if (e?.code === "P2025") throw new BadRequestException(`${what}: record not found`);
    throw e;
  }
}

/** Translate DB unique-key violations into a clean 409 instead of a 500. */
export async function uniq<T>(op: () => Promise<T>, what: string): Promise<T> {
  try {
    return await op();
  } catch (e: any) {
    if (e?.code === "P2002") throw new ConflictException(`${what} already exists`);
    if (e?.code === "P2003")
      throw new BadRequestException(`${what}: a referenced record does not exist`);
    if (e?.code === "P2025") throw new BadRequestException(`${what}: record not found`);
    throw e;
  }
}

export function requireFields(body: Record<string, unknown>, fields: string[]) {
  const missing = fields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === "",
  );
  if (missing.length > 0) {
    throw new BadRequestException(`Missing required field(s): ${missing.join(", ")}`);
  }
}

export function toInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new BadRequestException(`${name} must be an integer`);
  return n;
}
