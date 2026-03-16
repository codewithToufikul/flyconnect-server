import admin from "firebase-admin";
import { User } from "../models/user.model.js";

export class NotificationService {
  private static isInitialized = false;

  static init() {
    try {
      // Look for service account in environment or a specific file path
      // For now, we assume it's set in the environment or we provide a placeholder
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        let serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT;

        // Check if it's base64 (doesn't start with '{')
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

  static async sendNotification(
    userId: string,
    title: string,
    body: string,
    data?: any,
  ) {
    if (!this.isInitialized) return;

    try {
      const user = await User.findById(userId);
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) return;

      const message = {
        notification: { title, body },
        data: data || {},
        tokens: user.fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(
        `Successfully sent ${response.successCount} notifications to user ${userId}`,
      );

      // Cleanup invalid tokens if any
      if (response.failureCount > 0) {
        const failedTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success && user.fcmTokens) {
            const token = user.fcmTokens[idx];
            if (token) failedTokens.push(token);
          }
        });

        if (failedTokens.length > 0) {
          await User.findByIdAndUpdate(userId as string, {
            $pull: { fcmTokens: { $in: failedTokens } },
          });
        }
      }
    } catch (error) {
      console.error("Error sending notification:", error);
    }
  }

  static async registerToken(userId: string, token: string) {
    try {
      // Use $addToSet to avoid duplicates
      await User.findByIdAndUpdate(userId, {
        $addToSet: { fcmTokens: token },
      });
      return true;
    } catch (error) {
      console.error("Error registering FCM token:", error);
      return false;
    }
  }
}
