import { Controller, Get, Param, Post, Req } from "@nestjs/common";
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
    await this.prisma.notification.updateMany({
      where: { id: toInt(id, "id"), userId: req.user.sub },
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
