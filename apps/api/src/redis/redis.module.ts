import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";
import { CacheKeysService } from "./cache-keys.service";
import { REDIS } from "./redis.tokens";

export { REDIS };

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST ?? "redis",
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: 3,
        }),
    },
    CacheKeysService,
  ],
  exports: [REDIS, CacheKeysService],
})
export class RedisModule {}
