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
      } else {
        // If it was hidden/deleted for this user, restore it
        if (conversation.deletedFor && (conversation.deletedFor as any).some((d: any) => d && d.toString() === senderId)) {
          await Conversation.findByIdAndUpdate(conversation._id, {
            $pull: { deletedFor: new mongoose.Types.ObjectId(senderId) },
          });
        }
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
      const userId = req.user?.id;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const query: any = {
        conversationId: new mongoose.Types.ObjectId(conversationId as string),
      };

      if (userId) {
        query.deletedFor = { $ne: new mongoose.Types.ObjectId(userId) };
      }

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
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const conversations = await Conversation.find({
        participants: userId as any,
        deletedFor: { $ne: new mongoose.Types.ObjectId(userId) },
      })
        .sort({ lastMessageAt: -1 })
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

/**
 * @route   POST /api/v1/chats/mute/:conversationId
 * @desc    Mute or unmute a conversation for the current user
 * @access  Private
 */
router.post(
  "/mute/:conversationId",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { conversationId } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }

      // Check if already muted
      const isMuted = conversation.mutedBy?.some(
        (id: any) => id && id.toString() === userId.toString(),
      );

      if (isMuted) {
        // Unmute: Remove user from mutedBy array
        await Conversation.findByIdAndUpdate(conversationId, {
          $pull: { mutedBy: new mongoose.Types.ObjectId(userId) },
        });
      } else {
        // Mute: Add user to mutedBy array
        await Conversation.findByIdAndUpdate(conversationId, {
          $addToSet: { mutedBy: new mongoose.Types.ObjectId(userId) },
        });
      }

      const updated = await Conversation.findById(conversationId).populate(
        "participants",
        "name userName profileImage isOnline lastSeen",
      );

      res.status(200).json({
        success: true,
        message: isMuted ? "Conversation unmuted" : "Conversation muted",
        data: updated,
      });
    } catch (error) {
      console.error("Mute conversation error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   POST /api/v1/chats/clear
 * @desc    Clear all messages in a conversation for the current user
 * @access  Private
 */
router.post(
  "/clear",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { conversationId } = req.body;
      const userId = req.user?.id;

      if (!conversationId) {
        return res
          .status(400)
          .json({ success: false, message: "Conversation ID is required" });
      }

      const convObjectId = new mongoose.Types.ObjectId(conversationId as string);
      const userObjectId = new mongoose.Types.ObjectId(userId as string);

      // Add user to deletedFor for all existing messages in this conversation
      await Message.updateMany(
        { conversationId: convObjectId },
        { $addToSet: { deletedFor: userObjectId } }
      );

      res.status(200).json({
        success: true,
        message: "Chat cleared successfully",
      });
    } catch (error) {
      console.error("Clear chat error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   POST /api/v1/chats/delete-conversation
 * @desc    Delete/Hide a conversation for the current user
 * @access  Private
 */
router.post(
  "/delete-conversation",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { conversationId } = req.body;
      const userId = req.user?.id;

      if (!conversationId) {
        return res
          .status(400)
          .json({ success: false, message: "Conversation ID is required" });
      }

      const convObjectId = new mongoose.Types.ObjectId(conversationId as string);
      const userObjectId = new mongoose.Types.ObjectId(userId as string);

      // Hide conversation for this user
      await Conversation.findByIdAndUpdate(convObjectId, {
        $addToSet: { deletedFor: userObjectId },
      });

      // Also hide all current messages for this user
      await Message.updateMany(
        { conversationId: convObjectId },
        { $addToSet: { deletedFor: userObjectId } }
      );

      res.status(200).json({
        success: true,
        message: "Conversation deleted successfully",
      });
    } catch (error) {
      console.error("Delete conversation error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   POST /api/v1/chats/messages/delete
 * @desc    Delete a message (for me or for everyone)
 * @access  Private
 */
router.post(
  "/messages/delete",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { messageId, deleteForEveryone } = req.body;
      const userId = req.user?.id;

      if (!messageId) {
        return res
          .status(400)
          .json({ success: false, message: "Message ID is required" });
      }

      const message = await Message.findById(messageId);
      if (!message) {
        return res
          .status(404)
          .json({ success: false, message: "Message not found" });
      }

      const userObjectId = new mongoose.Types.ObjectId(userId as string);

      if (deleteForEveryone) {
        if (message.senderId.toString() !== userId?.toString()) {
          return res.status(403).json({
            success: false,
            message: "You can only delete your own messages for everyone",
          });
        }
        message.isDeleted = true;
        message.content = "This message was deleted";
        (message as any).mediaUrl = undefined;
        (message as any).thumbnailUrl = undefined;
        await message.save();
      } else {
        await Message.findByIdAndUpdate(messageId, {
          $addToSet: { deletedFor: userObjectId },
        });
      }

      res.status(200).json({
        success: true,
        message: deleteForEveryone
          ? "Message deleted for everyone"
          : "Message deleted for you",
      });
    } catch (error) {
      console.error("Delete message error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   POST /api/v1/chats/messages/delete-bulk
 * @desc    Delete multiple messages (for me or for everyone)
 * @access  Private
 */
router.post(
  "/messages/delete-bulk",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { messageIds, deleteForEveryone } = req.body;
      const userId = req.user?.id;

      if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "Message IDs array is required" });
      }

      const userObjectId = new mongoose.Types.ObjectId(userId as string);
      const objIds = messageIds.map((id: string) => new mongoose.Types.ObjectId(id));

      if (deleteForEveryone) {
        await Message.updateMany(
          { _id: { $in: objIds }, senderId: userObjectId },
          {
            $set: {
              isDeleted: true,
              content: "This message was deleted",
              mediaUrl: null,
              thumbnailUrl: null,
            },
          }
        );
      } else {
        await Message.updateMany(
          { _id: { $in: objIds } },
          { $addToSet: { deletedFor: userObjectId } }
        );
      }

      res.status(200).json({
        success: true,
        message: "Messages deleted successfully",
      });
    } catch (error) {
      console.error("Bulk delete error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  },
);

export const ChatRoutes = router;
