import type { Request, Response } from "express";
import { AgoraService } from "../services/agora.service.js";
import Call from "../models/Call.model.js";

export class CallController {
  /**
   * Generate token for a call session.
   * This is called by both caller and receiver when they enter the call screen.
   */
  static async generateToken(req: Request, res: Response) {
    try {
      const { channelName, callId, uid } = req.body;
      const userId = (req as any).user?.id;

      if (!channelName || !callId) {
        return res.status(400).json({
          success: false,
          message: "channelName and callId are required",
        });
      }

      // Verify the call exists and the user is a participant
      const callSession = await Call.findOne({
        callId,
        $or: [{ callerId: userId }, { receiverId: userId }],
      });

      if (!callSession) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized for this call session",
        });
      }

      // Use specific integer UID if provided, else fall back to 0 (auto)
      const numericUid = uid ? parseInt(uid) : 0;
      const token = AgoraService.generateToken(channelName, numericUid);

      if (!token) {
        return res.status(500).json({
          success: false,
          message: "Failed to generate Agora token",
        });
      }

      return res.status(200).json({
        success: true,
        token,
        appId: AgoraService.getAppId(),
      });
    } catch (error: any) {
      console.error("Token generation error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }

  static async getCallHistory(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const history = await Call.find({
        $or: [{ callerId: userId }, { receiverId: userId }],
      })
        .populate("callerId", "name profileImage")
        .populate("receiverId", "name profileImage")
        .sort({ createdAt: -1 })
        .limit(20);

      return res.status(200).json({
        success: true,
        history,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
