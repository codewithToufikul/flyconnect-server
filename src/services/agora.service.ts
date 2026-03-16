import pkg from "agora-access-token";
const { RtcTokenBuilder, RtcRole } = (pkg as any).default || pkg;

export class AgoraService {
  private static appId = process.env.AGORA_APP_ID || "";
  private static appCertificate = process.env.AGORA_APP_CERTIFICATE || "";

  /**
   * Generate RTC Token for a specific channel
   * @param channelName - Unique session name (e.g., call_<callId>)
   * @param uid - User ID (0 for auto-assign by Agora)
   * @param role - Host (default) or Attendee
   * @param expiryInSeconds - Default 3600 (1 hour)
   */
  static generateToken(
    channelName: string,
    uid: number = 0,
    role: number = RtcRole.PUBLISHER,
    expiryInSeconds: number = 3600,
  ) {
    if (!this.appId || !this.appCertificate) {
      console.error(
        "❌ Agora App ID or Certificate missing in environment variables.",
      );
      return null;
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expiryInSeconds;

    try {
      const token = RtcTokenBuilder.buildTokenWithUid(
        this.appId,
        this.appCertificate,
        channelName,
        uid,
        role,
        privilegeExpiredTs,
      );

      console.log(`🎫 Agora Token generated for channel: ${channelName}`);
      return token;
    } catch (error) {
      console.error("❌ Error generating Agora token:", error);
      return null;
    }
  }

  static getAppId() {
    return this.appId;
  }
}
