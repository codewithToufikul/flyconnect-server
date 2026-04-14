/**
 * VoIPService — APNs PushKit push notifications for iOS.
 *
 * WHY this exists:
 *   Firebase FCM cannot send `apns-push-type: voip` pushes because FCM manages
 *   the APNs connection internally and does not expose the voip push type.
 *   VoIP pushes MUST be sent directly to Apple's APNs HTTP/2 endpoint using
 *   a raw APNs device token (obtained via PushKit in the iOS app).
 *
 * WHAT it does:
 *   When a call is initiated, VoIPService sends a high-priority VoIP push
 *   directly to Apple's servers. Apple then wakes the iOS app immediately —
 *   even if it is in the background OR completely killed — and the app shows
 *   a native CallKit incoming-call screen.
 *
 * SETUP REQUIRED (one-time, by developer):
 *   1. Apple Developer Portal → Certificates, IDs & Profiles →
 *      Keys → Create a new key with "Apple Push Notifications service (APNs)" ticked.
 *      Download the .p8 file.  Note the Key ID.
 *   2. Add these environment variables to your .env / hosting config:
 *        APN_KEY          — full content of the .p8 file (including header/footer)
 *        APN_KEY_ID       — 10-char Key ID from Developer Portal  (e.g. "AB12CD34EF")
 *        APN_TEAM_ID      — 10-char Team ID from Developer Portal  (e.g. "XXXXXXXXXX")
 *        APN_BUNDLE_ID    — your app bundle identifier            (e.g. "com.flyconnect")
 *        APN_PRODUCTION   — "true" for production, "false" for sandbox (TestFlight / Xcode)
 */

import apn from "apn";
import { User } from "../models/user.model.js";

class VoIPServiceClass {
  private provider: apn.Provider | null = null;
  private bundleId: string = "";

  /** Call once at server startup (after env vars are loaded). */
  init() {
    const key      = process.env.APN_KEY;
    const keyId    = process.env.APN_KEY_ID;
    const teamId   = process.env.APN_TEAM_ID;
    const bundleId = process.env.APN_BUNDLE_ID;

    if (!key || !keyId || !teamId || !bundleId) {
      console.warn(
        "⚠️  [VoIPService] APNs credentials not configured. " +
        "Set APN_KEY, APN_KEY_ID, APN_TEAM_ID, APN_BUNDLE_ID in .env to enable " +
        "iOS VoIP push notifications.",
      );
      return;
    }

    const isProduction = process.env.APN_PRODUCTION === "true";
    this.bundleId = bundleId;

    try {
      // FIX: Ensure newlines in the private key are handled correctly
      const formattedKey = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;

      this.provider = new apn.Provider({
        token: {
          key: formattedKey,
          keyId: keyId,
          teamId: teamId,
        },
        production: isProduction,
      });

      console.log(
        `🔔 [VoIPService] APNs provider initialised (${isProduction ? "production" : "sandbox"}).`,
      );
    } catch (error) {
      console.error("❌ [VoIPService] Failed to initialise APNs provider:", error);
    }
  }

  /**
   * Send a VoIP push to every iOS device registered by the given user.
   *
   * @param userId   MongoDB userId of the call receiver
   * @param payload  Call data forwarded to the iOS app (callId, callerName, etc.)
   */
  async sendCallNotification(
    userId: string,
    payload: {
      callId: string;
      callerId: string;
      callerName: string;
      callerImage?: string;
      callType: "audio" | "video";
      channelName: string;
      sentAt: string;
    },
  ): Promise<boolean> {
    if (!this.provider) {
      console.warn("[VoIPService] Provider not initialised – skipping VoIP push.");
      return false;
    }

    try {
      const user = await User.findById(userId).select("voipToken name");
      if (!user?.voipToken) {
        console.log(
          `[VoIPService] No VoIP token for user ${userId}. ` +
          "Falling back to FCM for iOS.",
        );
        return false;
      }

      const note = new apn.Notification();

      // VoIP pushes use a special topic: <bundleId>.voip
      note.topic      = `${this.bundleId}.voip`;
      note.pushType   = "voip";
      note.priority   = 10;          // max priority — Apple delivers immediately
      note.expiry     = Math.floor(Date.now() / 1000) + 35; // TTL: 35 s (matches server auto-MISSED timeout)

      // The entire payload is available as notification.data in JS
      note.rawPayload = {
        type:        "CALL_INCOMING",
        callId:      payload.callId,
        callerId:    payload.callerId,
        callerName:  payload.callerName,
        callerImage: payload.callerImage || "",
        callType:    payload.callType,
        channelName: payload.channelName,
        sentAt:      payload.sentAt,
      };

      const result = await this.provider.send(note, user.voipToken);

      if (result.failed.length > 0) {
        const failure = result.failed[0];
        console.error(`❌ [VoIPService] Push failed for user ${userId}:`, {
          deviceToken: user.voipToken,
          error: failure.error,
          response: failure.response,
          status: (failure.response as any)?.status,
          reason: (failure.response as any)?.reason
        });

        // If the token is invalid, remove it from the DB
        const errReason = (failure.response as any)?.reason;
        if (errReason === "BadDeviceToken" || errReason === "Unregistered") {
          await User.findByIdAndUpdate(userId, { voipToken: null });
          console.log(`🧹 [VoIPService] Stale VoIP token removed for user ${userId}`);
        }
        return false;
      }

      console.log(`✅ [VoIPService] VoIP push delivered to ${user.name} (Token: ${user.voipToken.substring(0, 10)}...)`);
      return true;
    } catch (error) {
      console.error("❌ [VoIPService] Unexpected error sending push:", error);
      return false;
    }
  }

  /** Store / update a user's PushKit VoIP token. */
  async registerToken(userId: string, voipToken: string): Promise<boolean> {
    try {
      await User.findByIdAndUpdate(userId, { voipToken });
      console.log(`📡 [VoIPService] VoIP token registered for user ${userId}`);
      return true;
    } catch (error) {
      console.error("❌ [VoIPService] Token registration failed:", error);
      return false;
    }
  }

  /** Clear the VoIP token when the user logs out. */
  async clearToken(userId: string): Promise<void> {
    await User.findByIdAndUpdate(userId, { voipToken: null });
  }

  /** Shut down the APNs persistent connection gracefully. */
  shutdown() {
    this.provider?.shutdown();
  }
}

export const VoIPService = new VoIPServiceClass();
