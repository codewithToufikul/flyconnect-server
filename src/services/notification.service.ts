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
   * Send a data-only FCM message (silent/hidden).
   * Useful for calls, remote config sync, or when the app handles UI manually.
   */
  static async sendDataOnlyNotification(
    userId: string,
    data: Record<string, string>,
  ) {
    if (!this.isInitialized) return;

    try {
      const user = await User.findById(userId);
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

      console.log(`📡 [NotificationService] Sending DATA-ONLY multicast to ${user.name}...`);

      const message: admin.messaging.MulticastMessage = {
        data,
        android: {
          priority: "high", // Critical for wake-up
        },
        apns: {
          payload: {
            aps: {
              contentAvailable: true, // Required for background wake-up on iOS
            },
          },
          headers: {
            "apns-priority": "5", // High priority for data-only
            "apns-push-type": "background"
          },
        },
        tokens: user.fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`✅ [NotificationService] Data-only result: ${response.successCount} success.`);
      
      // Optional: Add token cleanup here too if needed, 
      // but sendNotification already handles it for the same tokens.
    } catch (error) {
      console.error("❌ Data-only notification error:", error);
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
