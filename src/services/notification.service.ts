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
   * FCM routes platform-specific config automatically per token:
   *
   * Android (via `android` config block):
   *   → Data-only, high-priority wakeup
   *   → index.js backgroundHandler catches it → Notifee full-screen/heads-up UI
   *
   * iOS (via `apns` config block):
   *   → contentAvailable:true  tries to wake the app in BACKGROUND
   *     (index.js backgroundHandler → RNCallKeep.displayIncomingCall native UI)
   *   → aps.alert shows a BANNER when the app is KILLED so the user can tap
   *     (App.tsx getInitialNotification → AsyncStorage → CallContext restores session)
   *   → apns-priority:10 + apns-push-type:voip-like setup for maximum delivery
   *
   * Note: Only one multicast is sent. FCM applies the correct config block
   * per device platform, so Android tokens use `android` and iOS tokens use `apns`.
   */
  static async sendDataOnlyNotification(
    userId: string,
    data: Record<string, string>,
  ) {
    if (!this.isInitialized) return;

    try {
      const user = await User.findById(userId);
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

      const isIncomingCall = data.type === "CALL_INCOMING";

      console.log(`📡 [NotificationService] Sending call push to ${user.name} (${user.fcmTokens.length} token(s))...`);

      const message: admin.messaging.MulticastMessage = {
        // data payload is delivered to ALL platforms
        data,

        // ── Android: data-only wake (no system banner; Notifee handles UI) ──
        android: {
          priority: "high",
          ttl: 45 * 1000,                                          // matches ghost-call window
          collapseKey: data.callId ? `call_${data.callId}` : undefined,
        },

        // ── iOS: contentAvailable (background handler) + alert (killed banner) ──
        apns: {
          payload: {
            aps: {
              // contentAvailable: true ensures the app is woken up in the background
              // to handle the incoming call data without showing a standard banner.
              // The VoIP push handles the actual CallKit UI.
              contentAvailable: true,
              sound: isIncomingCall ? "default" : undefined,
              badge: 0,
            },
          },
          headers: {
            "apns-priority": "10",          // highest priority
            // alert type is required by Apple when aps.alert is present
            "apns-push-type": isIncomingCall ? "alert" : "background",
            // Expire when the server auto-misses the call (35 s)
            "apns-expiration": Math.floor(Date.now() / 1000 + 35).toString(),
          },
        },

        tokens: user.fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(
        `✅ [NotificationService] Call push result: ${response.successCount} success, ${response.failureCount} failed`,
      );

      // Automatically remove invalid / stale iOS tokens
      if (response.failureCount > 0) {
        const staleTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success && user.fcmTokens) {
            const code = resp.error?.code;
            if (
              code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered"
            ) {
              staleTokens.push(user.fcmTokens[idx]);
            }
          }
        });
        if (staleTokens.length > 0) {
          await User.findByIdAndUpdate(userId, { $pull: { fcmTokens: { $in: staleTokens } } });
          console.log(`🧹 Removed ${staleTokens.length} stale FCM token(s) for user ${userId}`);
        }
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
