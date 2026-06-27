import { Router } from "express";
import type { Response } from "express";
import { User } from "../models/user.model.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import mongoose from "mongoose";

const router = Router();

/**
 * @route   GET /api/v1/users/search
 * @desc    Search for users by name, username or phone number
 * @access  Private
 */
router.get(
  "/search",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { q } = req.query;

      if (!q || typeof q !== "string") {
        return res.status(400).json({
          success: false,
          message: "Search query is required",
        });
      }

      const searchQuery = q.trim();
      const currentUserId = req.user?.id;
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const query: any = {
        $and: [
          { _id: { $ne: new mongoose.Types.ObjectId(currentUserId) } },
          {
            $or: [
              { name: { $regex: searchQuery, $options: "i" } },
              { userName: { $regex: searchQuery, $options: "i" } },
              { number: { $regex: searchQuery, $options: "i" } },
            ],
          },
        ],
      };

      const users = await User.find(query)
        .select("name userName number profileImage verificationStatus")
        .limit(20);

      res.status(200).json({
        success: true,
        data: users,
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  },
);

/**
 * @route   GET /api/v1/users/:id
 * @desc    Get user details by ID (including online status)
 * @access  Private
 */
router.get("/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const user = await User.findById(id).select(
      "name userName profileImage isOnline lastSeen verificationStatus blockedUsers",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const currentUserId = req.user?.id;
    const amIBlocked = user.blockedUsers?.some(
      (uid: any) => uid && uid.toString() === currentUserId?.toString(),
    );

    res.status(200).json({
      success: true,
      user: {
        ...user.toObject(),
        amIBlocked,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/**
 * @route   POST /api/v1/users/block/:id
 * @desc    Block a user
 * @access  Private
 */
router.post(
  "/block/:id",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const currentUserId = req.user?.id;

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID" });
      }

      if (id === currentUserId) {
        return res
          .status(400)
          .json({ success: false, message: "You cannot block yourself" });
      }

      await User.findByIdAndUpdate(currentUserId, {
        $addToSet: { blockedUsers: id },
      });

      res
        .status(200)
        .json({ success: true, message: "User blocked successfully" });
    } catch (error) {
      console.error("Block error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   POST /api/v1/users/unblock/:id
 * @desc    Unblock a user
 * @access  Private
 */
router.post(
  "/unblock/:id",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const currentUserId = req.user?.id;

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user ID" });
      }

      await User.findByIdAndUpdate(currentUserId, {
        $pull: { blockedUsers: id },
      });

      res
        .status(200)
        .json({ success: true, message: "User unblocked successfully" });
    } catch (error) {
      console.error("Unblock error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

/**
 * @route   GET /api/v1/users/me/blocks
 * @desc    Get current user's blocked list
 * @access  Private
 */
router.get(
  "/me/blocks",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const currentUserId = req.user?.id;
      const user = await User.findById(currentUserId).populate(
        "blockedUsers",
        "name userName profileImage",
      );

      res.status(200).json({
        success: true,
        blockedUsers: user?.blockedUsers || [],
      });
    } catch (error) {
      console.error("Get blocks error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  },
);

export const UserRoutes = router;
