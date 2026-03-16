import { Router } from "express";
import type { Response } from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import Conversation from "../models/Conversation.model.js";
import Message from "../models/Message.model.js";
import mongoose from "mongoose";

const router = Router();

/**
 * @route   POST /api/v1/chats/get-or-create
 * @desc    Get an existing conversation or create a new one between two users
 * @access  Private
 */
router.post(
  "/get-or-create",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { receiverId } = req.body;
      const senderId = req.user?.id;

      if (!receiverId) {
        return res
          .status(400)
          .json({ success: false, message: "Receiver ID is required" });
      }

      // Look for existing 1-on-1 conversation
      let conversation = await Conversation.findOne({
        isGroup: false,
        participants: { $all: [senderId, receiverId] },
      });

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [senderId, receiverId],
          isGroup: false,
        });
      }

      // Populate participants before returning
      await conversation.populate(
        "participants",
        "name userName profileImage isOnline lastSeen",
      );

      res.status(200).json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      console.error("Get/Create Conversation error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   GET /api/v1/chats/messages/:conversationId
 * @desc    Fetch messages for a specific conversation with pagination
 * @access  Private
 */
router.get(
  "/messages/:conversationId",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { conversationId } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const query: any = {
        conversationId: new mongoose.Types.ObjectId(conversationId as string),
      };

      const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("senderId", "name profileImage")
        .populate({
          path: "replyTo",
          populate: { path: "senderId", select: "name" },
        });

      const total = await Message.countDocuments(query);

      res.status(200).json({
        success: true,
        data: messages,
        pagination: {
          page,
          limit,
          total,
          hasMore: total > skip + messages.length,
        },
      });
    } catch (error) {
      console.error("Fetch messages error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   GET /api/v1/chats/inbox
 * @desc    Fetch the list of conversations (inbox) for the current user
 * @access  Private
 */
router.get(
  "/inbox",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      const conversations = await Conversation.find({
        participants: userId,
      })
        .sort({ updatedAt: -1 })
        .populate(
          "participants",
          "name userName profileImage isOnline lastSeen",
        )
        .populate("lastMessage");

      res.status(200).json({
        success: true,
        data: conversations,
      });
    } catch (error) {
      console.error("Fetch inbox error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

export const ChatRoutes = router;
