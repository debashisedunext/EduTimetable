import { Controller, Get, NotFoundException, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from "../auth/decorators";
import { PLATFORM_KEY } from "../control/platform.guard";

/**
 * Dev-only route census (Phase 9.10, §17.8).
 *
 * The isolation suite has to answer "does *every* endpoint refuse another
 * school's ids". A hand-written list of endpoints answers that question only
 * on the day it is written: the next controller someone adds is untested, and
 * nothing says so — the suite still passes, which is worse than having no
 * suite, because it reports safety it never checked.
 *
 * So the suite asks the running application what routes it actually has, and
 * requires every one of them to be either swept or explicitly classified. A new
 * endpoint therefore *fails the build* until somebody decides which it is.
 * That is the whole point of this endpoint existing.
 *
 * It reports the guard metadata alongside each route because that is what
 * makes an exemption legible: a `@Public()` route has no session to scope, and
 * a platform route sits above schools by design (§17.6). Both are real
 * exemptions; "I forgot" is not, and looks different in the output.
 *
 * Disabled in production. It reveals nothing an attacker could not learn by
 * probing, but a route listing is a map, and there is no reason to publish one.
 */
@Controller("dev")
export class RouteCensusController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly config: ConfigService,
  ) {}

  @Get("routes")
  routes() {
    if (this.config.get("NODE_ENV") === "production") throw new NotFoundException();

    const routes: RouteInfo[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const target = wrapper.metatype;
      if (!target) continue;
      const base = normalize(Reflect.getMetadata(PATH_METADATA, target) ?? "");

      // Read from the prototype, not the instance: Nest's own route explorer
      // does the same, and it is the only place the decorator metadata lives.
      const proto = Object.getPrototypeOf(wrapper.instance ?? {});
      for (const key of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[key];
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue;

        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        routes.push({
          controller: target.name,
          handler: key,
          method: RequestMethod[verb] ?? "GET",
          // `/api` is added by the global prefix, which callers already know.
          path: join(base, normalize(path)),
          public: Boolean(
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, target),
          ),
          platform: Boolean(
            Reflect.getMetadata(PLATFORM_KEY, handler) ?? Reflect.getMetadata(PLATFORM_KEY, target),
          ),
          permissions: [
            ...((Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[]) ?? []),
            ...((Reflect.getMetadata(PERMISSIONS_KEY, target) as string[]) ?? []),
          ],
        });
      }
    }

    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return { count: routes.length, routes };
  }
}

interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  path: string;
  public: boolean;
  platform: boolean;
  permissions: string[];
}

const normalize = (p: string) => (p === "/" ? "" : p.startsWith("/") ? p : `/${p}`);
const join = (base: string, path: string) => `${base}${path}` || "/";
