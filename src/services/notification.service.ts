import admin from "firebase-admin";
import { User } from "../models/user.model.js";

export class NotificationService {
  private static isInitialized = false;

  static init() {
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        let serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT;

        // Support both raw JSON and base64-encoded
        if (!serviceAccountValue.trim().startsWith("{")) {
          serviceAccountValue = Buffer.from(
            serviceAccountValue,
            "base64",
          ).toString("utf-8");
        }

        const serviceAccount = JSON.parse(serviceAccountValue);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        this.isInitialized = true;
        console.log("🔥 Firebase Admin initialized.");
      } else {
        console.warn(
          "⚠️ Firebase Service Account not found. Push notifications will be disabled.",
        );
      }
    } catch (error) {
      console.error("❌ Firebase initialization error:", error);
    }
  }

  /**
   * Build a smart, human-readable notification body depending on content type.
   */
  private static buildNotificationBody(
    content: string,
    contentType: string,
  ): string {
    switch (contentType) {
      case "image":
        return "📷 Photo পাঠিয়েছে";
      case "video":
        return "🎥 Video পাঠিয়েছে";
      case "audio":
        return "🎵 Voice message পাঠিয়েছে";
      case "file":
        return "📎 File পাঠিয়েছে";
      case "text":
      default:
        return content.length > 80
          ? content.substring(0, 80) + "..."
          : content;
    }
  }

  /**
   * Send a push notification to a user.
   * @param userId - Recipient's MongoDB userId
   * @param title - Notification title (usually sender's name)
   * @param content - Raw message content
   * @param contentType - 'text' | 'image' | 'video' | 'audio' | 'file'
   * @param data - Extra data payload for navigation (conversationId, senderId etc.)
   */
  static async sendNotification(
    userId: string,
    title: string,
    content: string,
    data?: Record<string, string>,
    contentType: string = "text",
  ) {
    if (!this.isInitialized) return;

    try {
      const user = await User.findById(userId);
      console.log(`🔍 [NotificationService] Looking up tokens for user ${userId}...`);
      
      if (!user) {
        console.error(`❌ [NotificationService] User ${userId} not found in database.`);
        return;
      }
      
      if (!user.fcmTokens || user.fcmTokens.length === 0) {
        console.warn(`⚠️ [NotificationService] User ${user.name} (${userId}) has 0 registered FCM tokens.`);
        return;
      }

      console.log(`📱 [NotificationService] Found ${user.fcmTokens.length} tokens for user ${user.name}.`);

      const body = this.buildNotificationBody(content, contentType);

      // All values in the data object MUST be strings for FCM
      const dataPayload: Record<string, string> = {
        type: "CHAT_MESSAGE",
        contentType,
        ...(data || {}),
      };

      const message: admin.messaging.MulticastMessage = {
        notification: {
          title,
          body,
        },
        data: dataPayload,
        android: {
          priority: "high",
          notification: {
            channelId: "chat_messages",
            sound: "default",
            priority: "high",
            defaultSound: true,
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
              contentAvailable: true,
            },
          },
          headers: {
            "apns-priority": "10",
          },
        },
        tokens: user.fcmTokens,
      };

      console.log(`🚀 [NotificationService] Sending FCM multicast to user ${userId}...`);
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(
        `✅ [NotificationService] Multicast result for ${userId}: ${response.successCount} success, ${response.failureCount} failed`,
      );

      if (response.failureCount > 0) {
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            console.error(`❌ [NotificationService] Token ${idx} failed:`, resp.error?.message);
          }
        });
      }

      // Cleanup stale/invalid tokens automatically
      if (response.failureCount > 0) {
        const failedTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success && user.fcmTokens) {
            const token = user.fcmTokens[idx];
            const errorCode = resp.error?.code;
            // Only remove truly invalid tokens, not transient errors
            if (
              token &&
              (errorCode === "messaging/invalid-registration-token" ||
                errorCode === "messaging/registration-token-not-registered")
            ) {
              failedTokens.push(token);
            }
          }
        });

        if (failedTokens.length > 0) {
          await User.findByIdAndUpdate(userId as string, {
            $pull: { fcmTokens: { $in: failedTokens } },
          });
          console.log(
            `🧹 Removed ${failedTokens.length} stale FCM tokens for user ${userId}`,
          );
        }
      }
    } catch (error) {
      console.error("Error sending notification:", error);
    }
  }

  /**
   * Send a platform-optimized call notification.
   *
   * Android strategy → Data-only (high-priority wakeup):
   *   The app's index.js backgroundHandler catches it and shows a
   *   Notifee full-screen / heads-up call notification.
   *
   * iOS strategy → Alert notification + data payload:
   *   iOS will NOT reliably wake a *killed* app from a data-only push.
   *   Only APNs VoIP (PushKit) guarantees a wakeup, but that requires a
   *   separate certificate.  The next best thing is a high-priority *alert*
   *   push: iOS delivers it reliably, shows a banner, and the user taps it.
   *   App.tsx > getInitialNotification() then reads the data and restores
   *   the call session via AsyncStorage → CallContext.
   */
  static async sendDataOnlyNotification(
    userId: string,
    data: Record<string, string>,
  ) {
    if (!this.isInitialized) return;

    try {
      const user = await User.findById(userId);
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

      const isCallNotification = data.type === "CALL_INCOMING" || data.type === "CALL_CANCELLED" || data.type === "CALL_ENDED";
      const isIncomingCall    = data.type === "CALL_INCOMING";

      console.log(`📡 [NotificationService] Sending call notification to ${user.name} (tokens: ${user.fcmTokens.length})...`);

      // ── Android: Data-only → backgroundHandler → Notifee custom UI ─────────
      const androidMessage: admin.messaging.MulticastMessage = {
        data,
        android: {
          priority: "high",
          ttl: 45 * 1000, // 45 s matches client-side ghost-call window
          collapseKey: isCallNotification ? `call_${data.callId}` : undefined,
        },
        tokens: user.fcmTokens,
      };

      // ── iOS: Alert notification + data → system-guaranteed delivery ─────────
      // apns-push-type MUST be "alert" for normal APNs delivery.
      // Do NOT mix contentAvailable=true with alert on a data-only message;
      // that can cause iOS to silently drop or throttle the push.
      const iosMessage: admin.messaging.MulticastMessage = {
        data, // FCM still attaches data so backgroundHandler / getInitialNotification can read it
        notification: isIncomingCall
          ? {
              title: `📞 ${data.callerName || "Incoming Call"}`,
              body: `Incoming ${data.callType || "audio"} call — tap to join`,
            }
          : undefined, // CALL_CANCELLED / CALL_ENDED → silent cancel; no banner needed
        apns: {
          payload: {
            aps: isIncomingCall
              ? {
                  // 'alert' type — iOS delivers reliably even for killed apps
                  alert: {
                    title: `📞 ${data.callerName || "Incoming Call"}`,
                    body:  `Incoming ${data.callType || "audio"} call — tap to join`,
                  },
                  sound: "default",
                  badge: 0,
                  // contentAvailable intentionally omitted:
                  // mixing alert + content-available can cause silent drops.
                }
              : {
                  // Silent cancel / end notification
                  contentAvailable: true,
                  sound: "" as any,
                },
          },
          headers: {
            "apns-priority":   "10",    // max priority
            "apns-push-type":  isIncomingCall ? "alert" : "background",
            // Expires exactly when the server-side call auto-misses (35 s),
            // so a stale wake-up is never shown.
            "apns-expiration": Math.floor(Date.now() / 1000 + 35).toString(),
          },
        },
        tokens: user.fcmTokens,
      };

      // Send both in parallel; failures on one platform do not block the other.
      const [androidResult, iosResult] = await Promise.allSettled([
        admin.messaging().sendEachForMulticast(androidMessage),
        admin.messaging().sendEachForMulticast(iosMessage),
      ]);

      const aOk = androidResult.status === "fulfilled" ? androidResult.value.successCount : 0;
      const iOk = iosResult.status    === "fulfilled" ? iosResult.value.successCount    : 0;
      console.log(`✅ [NotificationService] Call push: Android ${aOk} ok | iOS ${iOk} ok`);

      if (androidResult.status === "rejected") {
        console.error("❌ [NotificationService] Android push error:", androidResult.reason);
      }
      if (iosResult.status === "rejected") {
        console.error("❌ [NotificationService] iOS push error:", iosResult.reason);
      }
    } catch (error) {
      console.error("❌ [NotificationService] sendDataOnlyNotification error:", error);
    }
  }

  static async registerToken(userId: string, token: string) {
    try {
      await User.findByIdAndUpdate(userId, {
        $addToSet: { fcmTokens: token },
      });
      console.log(`📡 [NotificationService] Registered/Updated FCM token for user ${userId}`);
      return true;
    } catch (error) {
      console.error("Error registering FCM token:", error);
      return false;
    }
  }
}
