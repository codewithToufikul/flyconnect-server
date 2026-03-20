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
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const history = await Call.find({
        $or: [{ callerId: userId }, { receiverId: userId }],
      })
        .populate("callerId", "name profileImage isOnline lastSeen")
        .populate("receiverId", "name profileImage isOnline lastSeen")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await Call.countDocuments({
        $or: [{ callerId: userId }, { receiverId: userId }],
      });

      return res.status(200).json({
        success: true,
        history,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }

  /**
   * Decline an incoming call via API (background support)
   */
  static async declineCall(req: Request, res: Response) {
    try {
      const { callId, callerId } = req.body;
      const userId = (req as any).user?.id;

      if (!callId || !callerId) {
        return res.status(400).json({ success: false, message: "callId and callerId are required" });
      }

      await (await import("../models/Call.model.js")).default.findOneAndUpdate(
        { callId }, { status: "DECLINED" }
      );

      // Notify caller via Socket.IO
      const { SocketService } = await import("../services/socket.service.js");
      const io = SocketService.getIO();
      if (io) {
        console.log(`🛑 [CallController] Sending call:declined for ${callId} to caller ${callerId}`);
        io.to(callerId).emit("call:declined", { callId });
      }

      return res.status(200).json({ success: true, message: "Call declined" });
    } catch (error) {
      console.error("Decline API Error:", error);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
}
