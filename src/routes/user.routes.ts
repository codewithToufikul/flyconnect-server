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
      "name userName profileImage isOnline lastSeen verificationStatus",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export const UserRoutes = router;
