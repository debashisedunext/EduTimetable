import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { ErpSsoTokenPayload } from "@edutimetable/shared";
import { TenantRegistryService } from "../control/tenant-registry.service";

/**
 * Verifying the ERP's SSO tokens (§15.1, extended in §17.5).
 *
 * Before Phase 9.4 there was exactly one `ERP_PUBLIC_KEY`, which is fine while
 * there is one ERP installation and wrong the moment there are two: any
 * installation holding that key could mint a token for any school in the
 * deployment. The control plane's `erp_instances` table holds one key per
 * installation, and a token selects its own by the `kid` in its JWT header (or
 * by its `iss` claim). A token whose key is not registered is rejected — it is
 * not silently fallen back to the global key.
 *
 * The single configured key remains the whole story for a deployment that has
 * one ERP, and in dev, where an in-memory keypair is generated so the stub
 * issuer can sign tokens and the full SSO round trip works locally.
 */
@Injectable()
export class ErpKeysService implements OnModuleInit {
  private readonly logger = new Logger(ErpKeysService.name);
  publicKey!: string;
  /** Present only in dev (in-memory pair). Never set in production. */
  privateKey: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: TenantRegistryService,
  ) {}

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

  /**
   * Verify an incoming ERP SSO token (RS256 only), against the key belonging to
   * the installation that signed it. Throws on any failure.
   *
   * Async because selecting the key may need the registry. The key is chosen
   * from the token's *header*, which is unauthenticated data — but that is
   * safe: it only decides which public key to try, and the signature check that
   * follows is what grants anything.
   */
  async verifyErpToken(token: string): Promise<ErpSsoTokenPayload> {
    const key = await this.keyFor(token);
    return jwt.verify(token, key, { algorithms: ["RS256"] }) as unknown as ErpSsoTokenPayload;
  }

  private async keyFor(token: string): Promise<string> {
    if (!this.registry.available) return this.publicKey;

    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const issuer =
      decoded && typeof decoded.payload === "object" ? (decoded.payload as jwt.JwtPayload).iss : undefined;

    if (kid) {
      const instance = await this.registry.erpInstanceByKid(kid);
      if (instance?.publicKeyPem) return instance.publicKeyPem;
      // A named key that is not registered must fail, not fall through to the
      // global one — falling through is exactly how one installation would end
      // up trusted to sign for another's schools.
      throw new Error(`No registered ERP installation for key id '${kid}'`);
    }

    if (issuer) {
      const instance = await this.registry.erpInstanceByIssuer(issuer);
      if (instance?.publicKeyPem) return instance.publicKeyPem;
    }

    // No key id and no matching issuer: a single-installation deployment, which
    // is what the configured key is for.
    return this.publicKey;
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
