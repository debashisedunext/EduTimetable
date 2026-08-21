import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { ErpSsoTokenPayload } from "@edutimetable/shared";

/**
 * Holds the ERP SSO signing keys (§15.1). In production, ERP_PUBLIC_KEY (PEM)
 * must be configured and only verification happens here. In dev, with no key
 * configured, an in-memory RSA pair is generated so the stub ERP endpoint can
 * sign tokens and the full SSO round trip works locally.
 */
@Injectable()
export class ErpKeysService implements OnModuleInit {
  private readonly logger = new Logger(ErpKeysService.name);
  publicKey!: string;
  /** Present only in dev (in-memory pair). Never set in production. */
  privateKey: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const configured = this.config.get<string>("ERP_PUBLIC_KEY");
    if (configured && configured.trim().length > 0) {
      this.publicKey = configured;
      this.logger.log("Using configured ERP public key for SSO verification");
      return;
    }
    if (this.config.get("NODE_ENV") === "production") {
      throw new Error("ERP_PUBLIC_KEY is required in production (§15.1)");
    }
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    this.privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.logger.warn("No ERP_PUBLIC_KEY set — generated in-memory dev keypair (SSO stub enabled)");
  }

  /** Verify an incoming ERP SSO token (RS256 only). Throws on any failure. */
  verifyErpToken(token: string): ErpSsoTokenPayload {
    return jwt.verify(token, this.publicKey, {
      algorithms: ["RS256"],
    }) as unknown as ErpSsoTokenPayload;
  }

  /** Dev only: sign a stand-in ERP token with the in-memory dev private key. */
  signDevErpToken(claims: Omit<ErpSsoTokenPayload, "jti" | "exp">): string {
    if (!this.privateKey) throw new Error("Dev ERP signing unavailable without dev keypair");
    return jwt.sign(claims as object, this.privateKey, {
      algorithm: "RS256",
      expiresIn: "60s",
      jwtid: randomUUID(),
    });
  }
}
