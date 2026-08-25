import { Controller, Get, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";

/** §9 Notification Center — a user only ever sees their own rows. */
@Controller("notifications")
@RequirePermission(PERMISSIONS.NOTIFICATIONS_VIEW)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rows = await this.prisma.notification.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      isRead: n.isRead,
      createdAt: n.createdAt,
    }));
  }

  @Get("unread-count")
  async unread(@Req() req: AuthedRequest) {
    const count = await this.prisma.notification.count({
      where: { userId: req.user.sub, isRead: false },
    });
    return { count };
  }

  @Post(":id/read")
  async markRead(@Req() req: AuthedRequest, @Param("id") id: string) {
    const notificationId = toInt(id, "id");
    // The `updateMany` below already cannot touch another user's row — it is
    // filtered by owner and scoped to the school on top of that. But without
    // this check it would match nothing and still answer `{ok: true}`, telling
    // a caller an action succeeded on a row that is not theirs. Isolation's
    // contract is that someone else's id is *not found* (§17.8), and an
    // endpoint that says "fine" instead is indistinguishable, from the
    // outside, from one that really did the write.
    const own = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId: req.user.sub },
      select: { id: true },
    });
    if (!own) throw new NotFoundException("Notification not found");

    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId: req.user.sub },
      data: { isRead: true },
    });
    return { ok: true };
  }

  @Post("read-all")
  async markAllRead(@Req() req: AuthedRequest) {
    await this.prisma.notification.updateMany({
      where: { userId: req.user.sub, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  }
}
